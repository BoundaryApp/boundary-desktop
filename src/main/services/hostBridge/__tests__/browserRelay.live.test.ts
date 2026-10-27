import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebSocket } from 'ws';
import { startBridgeServers, type BridgeServers } from '../bridgeServer';
import { BrowserRelay } from '../browserRelay';
import { findGoogleChrome } from '../browserConfig';
import { DEFAULT_BLOCKED_SITES } from '../cdpPolicy';

/**
 * The relay against the real Google Chrome, driven by Playwright and a raw CDP client at the
 * same time (Hermes's driver plus its dialog supervisor). Opens a Chrome window for a few
 * seconds and loads only data: pages. Opt in: BOUNDARY_LIVE_CHROME=1.
 */

const chromePath = findGoogleChrome();
const live = process.env.BOUNDARY_LIVE_CHROME === '1' && Boolean(chromePath);
const TOKEN = 'live-browser-token';

describe.skipIf(!live)('browser relay with real Chrome', () => {
  let servers: BridgeServers;
  let relay: BrowserRelay;
  let profileDir: string;
  let url: string;
  const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];

  beforeAll(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-relay-live-'));
    relay = new BrowserRelay(
      { enabled: true, chrome: { chromePath: chromePath as string, profileDir }, policy: { blocked: [...DEFAULT_BLOCKED_SITES], allowed: [] } },
      (message, data) => logs.push({ message, data })
    );
    servers = await startBridgeServers({ mcpToken: 'unused', browserToken: TOKEN, callTool: async () => ({ content: [] }), browserRelay: relay });
    url = `ws://127.0.0.1:${servers.browserPort}/devtools/browser/boundary?token=${TOKEN}`;
  }, 30_000);

  afterAll(async () => {
    await relay?.close();
    await servers?.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it('serves Playwright, keeps the page across reconnects, and enforces policy', async () => {
    let browser: Browser = await chromium.connectOverCDP(url);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto('data:text/html,<h1>relay ok</h1>');
    expect(await page.textContent('h1')).toBe('relay ok');
    expect(await page.evaluate(() => navigator.webdriver)).toBe(false);
    expect((await page.screenshot()).length).toBeGreaterThan(1000);

    await expect(page.goto('https://mail.google.com/')).rejects.toThrow(/blocked-sites/);
    await expect(page.goto('file:///etc/hosts')).rejects.toThrow(/file:/);
    await expect(context.cookies()).rejects.toThrow(/doesn't allow/);

    // A second client at the same time, like Hermes's dialog supervisor.
    const raw = new WebSocket(url);
    await new Promise((resolve, reject) => {
      raw.once('open', resolve);
      raw.once('error', reject);
    });
    const replies = new Map<number, any>();
    raw.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id) replies.set(message.id, message);
    });
    const call = async (id: number, method: string, params: object = {}, sessionId?: string) => {
      raw.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(id);
    };
    const { result } = await call(1, 'Target.getTargets');
    const target = result.targetInfos.find((info: any) => info.url.startsWith('data:text/html,<h1>relay'));
    expect(target).toBeTruthy();
    const attached = await call(2, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const evaluated = await call(3, 'Runtime.evaluate', { expression: 'document.querySelector("h1").textContent', returnByValue: true }, attached.result.sessionId);
    expect(evaluated.result.result.value).toBe('relay ok');
    raw.close();

    // Playwright's "close" only disconnects it; the page is still there for the next client.
    await browser.close();
    browser = await chromium.connectOverCDP(url);
    const pages = browser.contexts()[0].pages();
    expect(await Promise.all(pages.map((p) => p.url()))).toContain('data:text/html,<h1>relay ok</h1>');
    await browser.close();

    const closed = logs.filter((entry) => entry.message === 'cdp client closed');
    expect(closed.length).toBeGreaterThanOrEqual(3);
    console.log('methods seen:', JSON.stringify(closed.map((entry) => entry.data), null, 1));
  }, 60_000);
});
