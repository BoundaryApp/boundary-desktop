import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpMux, type CdpClient } from '../cdpMux';
import type { SitePolicy } from '../cdpPolicy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** Enough of Chrome for routing tests: replies, and announces attaches before replying. */
class FakeChrome {
  received: Json[] = [];
  targets: Json[] = [{ targetId: 'T1', type: 'page', url: 'https://example.com/' }];
  private nextSession = 1;
  mux!: CdpMux;

  send = (message: Json) => {
    this.received.push(message);
    const reply = (result: Json = {}) => this.mux.handleChromeMessage({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
    switch (message.method) {
      case 'Target.getTargets':
        return reply({ targetInfos: this.targets });
      case 'Target.attachToTarget': {
        const sessionId = `S${this.nextSession++}`;
        const targetInfo = this.targets.find((t) => t.targetId === message.params.targetId);
        this.mux.handleChromeMessage({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo, waitingForDebugger: false } });
        return reply({ sessionId });
      }
      default:
        return reply();
    }
  };

  sent(method: string): Json[] {
    return this.received.filter((m) => m.method === method);
  }
}

class FakeClient implements CdpClient {
  inbox: Json[] = [];
  closed = false;
  send = (message: Json) => this.inbox.push(message);
  close = () => {
    this.closed = true;
  };
  replyTo(id: number | string): Json | undefined {
    return this.inbox.find((m) => m.id === id);
  }
  events(method: string): Json[] {
    return this.inbox.filter((m) => m.method === method);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let chrome: FakeChrome;
let mux: CdpMux;
let policy: SitePolicy;
let log: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  chrome = new FakeChrome();
  policy = { blocked: ['mail.google.com'], allowed: [] };
  log = vi.fn();
  mux = new CdpMux({ sendToChrome: chrome.send, policy: () => policy, log });
  chrome.mux = mux;
  await mux.start();
});

function connect(): FakeClient {
  const client = new FakeClient();
  mux.addClient(client);
  return client;
}

const cmd = (client: FakeClient, id: number, method: string, params: Json = {}, sessionId?: string) =>
  mux.handleClientMessage(client, JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));

describe('CdpMux', () => {
  it('gives each client its own id space', async () => {
    const a = connect();
    const b = connect();
    cmd(a, 1, 'Browser.getVersion');
    cmd(b, 1, 'Browser.getVersion');
    const forwarded = chrome.sent('Browser.getVersion').map((m) => m.id);
    expect(new Set(forwarded).size).toBe(2);
    expect(a.replyTo(1)).toMatchObject({ id: 1, result: {} });
    expect(b.replyTo(1)).toMatchObject({ id: 1, result: {} });
  });

  it('refuses blocked methods without forwarding them', () => {
    const a = connect();
    cmd(a, 7, 'Network.getAllCookies');
    expect(a.replyTo(7)?.error?.message).toMatch(/doesn't allow Network.getAllCookies/);
    expect(chrome.sent('Network.getAllCookies')).toHaveLength(0);
  });

  it('emulates auto-attach per client, announcing pages before the reply', async () => {
    const a = connect();
    const b = connect();
    cmd(a, 1, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    cmd(b, 1, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await flush();
    const aAttach = a.events('Target.attachedToTarget');
    const bAttach = b.events('Target.attachedToTarget');
    expect(aAttach).toHaveLength(1);
    expect(bAttach).toHaveLength(1);
    expect(aAttach[0].params.sessionId).not.toBe(bAttach[0].params.sessionId);
    expect(a.inbox.indexOf(aAttach[0])).toBeLessThan(a.inbox.findIndex((m) => m.id === 1));
    // Chrome never sees a browser-wide auto-attach, so clients can't override each other.
    expect(chrome.received.filter((m) => m.method === 'Target.setAutoAttach' && !m.sessionId)).toHaveLength(0);
  });

  it('attaches auto-attach clients to new pages', async () => {
    const a = connect();
    cmd(a, 1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await flush();
    chrome.targets.push({ targetId: 'T2', type: 'page', url: 'about:blank' });
    mux.handleChromeMessage({ method: 'Target.targetCreated', params: { targetInfo: chrome.targets[1] } });
    await flush();
    expect(a.events('Target.attachedToTarget').map((m) => m.params.targetInfo.targetId)).toEqual(['T1', 'T2']);
  });

  it('keeps sessions private to the client that owns them', async () => {
    const a = connect();
    const b = connect();
    cmd(a, 1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await flush();
    const session = a.events('Target.attachedToTarget')[0].params.sessionId;

    cmd(b, 2, 'Runtime.evaluate', { expression: 'document.cookie' }, session);
    expect(b.replyTo(2)?.error?.message).toMatch(/No session/);

    mux.handleChromeMessage({ method: 'Page.loadEventFired', sessionId: session, params: {} });
    expect(a.events('Page.loadEventFired')).toHaveLength(1);
    expect(b.events('Page.loadEventFired')).toHaveLength(0);
  });

  it('routes an explicit attach to the client that asked', () => {
    const a = connect();
    cmd(a, 3, 'Target.attachToTarget', { targetId: 'T1', flatten: true });
    const sessionId = a.replyTo(3)?.result?.sessionId;
    expect(sessionId).toBeTruthy();
    expect(a.events('Target.attachedToTarget')[0].params.sessionId).toBe(sessionId);
    cmd(a, 4, 'Page.enable', {}, sessionId);
    expect(a.replyTo(4)).toMatchObject({ result: {} });
  });

  it('refuses navigation, new tabs and attaches to blocked sites', () => {
    const a = connect();
    cmd(a, 1, 'Target.createTarget', { url: 'https://mail.google.com/' });
    expect(a.replyTo(1)?.error?.message).toMatch(/blocked-sites/);
    cmd(a, 2, 'Target.attachToTarget', { targetId: 'T1', flatten: true });
    const session = a.replyTo(2)?.result.sessionId;
    cmd(a, 3, 'Page.navigate', { url: 'file:///etc/passwd' }, session);
    expect(a.replyTo(3)?.error?.message).toMatch(/file:/);

    chrome.targets.push({ targetId: 'T9', type: 'page', url: 'https://mail.google.com/mail' });
    mux.handleChromeMessage({ method: 'Target.targetCreated', params: { targetInfo: chrome.targets.at(-1) } });
    cmd(a, 4, 'Target.attachToTarget', { targetId: 'T9', flatten: true });
    expect(a.replyTo(4)?.error?.message).toMatch(/blocked-sites/);
  });

  it('closes a page that moves to a blocked site and hides it from clients', () => {
    const a = connect();
    cmd(a, 1, 'Target.setDiscoverTargets', { discover: true });
    mux.handleChromeMessage({
      method: 'Target.targetInfoChanged',
      params: { targetInfo: { targetId: 'T1', type: 'page', url: 'https://mail.google.com/mail' } },
    });
    expect(chrome.sent('Target.closeTarget')).toEqual([expect.objectContaining({ params: { targetId: 'T1' } })]);
    expect(a.events('Target.targetInfoChanged')).toHaveLength(0);
  });

  it('announces existing targets to a client that asks for discovery', () => {
    const a = connect();
    cmd(a, 1, 'Target.setDiscoverTargets', { discover: true });
    expect(a.events('Target.targetCreated').map((m) => m.params.targetInfo.targetId)).toEqual(['T1']);
    expect(chrome.received.filter((m) => m.method === 'Target.setDiscoverTargets')).toHaveLength(1); // the relay's own
  });

  it('detaches a client’s sessions when it leaves and drops its late replies', async () => {
    const a = connect();
    cmd(a, 1, 'Target.setAutoAttach', { autoAttach: true, flatten: true });
    await flush();
    const session = a.events('Target.attachedToTarget')[0].params.sessionId;
    mux.removeClient(a);
    expect(chrome.sent('Target.detachFromTarget')).toEqual([expect.objectContaining({ params: { sessionId: session } })]);
    expect(log).toHaveBeenCalledWith('cdp client closed', expect.objectContaining({ methods: { 'Target.setAutoAttach': 1 } }));
  });

  it('answers Browser.close itself and disconnects only that client', async () => {
    const a = connect();
    cmd(a, 1, 'Browser.close');
    expect(a.replyTo(1)).toMatchObject({ result: {} });
    expect(chrome.sent('Browser.close')).toHaveLength(0);
    await flush();
    expect(a.closed).toBe(true);
  });

  it('closes every client when Chrome goes away', () => {
    const a = connect();
    const b = connect();
    mux.chromeClosed();
    expect(a.closed && b.closed).toBe(true);
    expect(mux.clientCount).toBe(0);
  });

  it('ignores malformed client messages', () => {
    const a = connect();
    mux.handleClientMessage(a, 'not json');
    mux.handleClientMessage(a, JSON.stringify({ method: 'Page.enable' }));
    expect(a.inbox).toHaveLength(0);
  });
});
