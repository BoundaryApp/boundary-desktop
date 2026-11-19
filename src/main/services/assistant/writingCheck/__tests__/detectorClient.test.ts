import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => vi.fn());
vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: log }));

import { checkWithDetector, detectorStatus, type DetectorDeps } from '../detectorClient';

const TEXT = 'word '.repeat(60).trim();
const MANIFEST = {
  id: 'io.github.kaxline.stack.detector',
  store: { dataLeaves: 'The text you check is sent to the detector you chose.' },
};

interface Call {
  url: string;
  init: RequestInit;
}

describe('detector client', () => {
  let root: string;
  let calls: Call[];
  let replies: Array<Response | Error>;
  let consented: Set<string>;
  let deps: DetectorDeps;

  const tokenPath = () => path.join(root, 'data', 'addons', 'detector', 'secrets', 'http_token');
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-detector-'));
    fs.mkdirSync(path.join(root, 'addons', 'detector'), { recursive: true });
    fs.writeFileSync(path.join(root, 'addons', 'detector', 'addon.json'), JSON.stringify(MANIFEST));
    fs.mkdirSync(path.dirname(tokenPath()), { recursive: true });
    fs.writeFileSync(tokenPath(), 'a'.repeat(64) + '\n');
    calls = [];
    replies = [];
    consented = new Set();
    log.mockClear();
    deps = {
      stackRoot: () => root,
      dataRoot: (r) => path.join(r, 'data'),
      fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = replies.shift();
        if (!next) throw new Error('no reply queued');
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch,
      consent: { has: (p) => consented.has(p), add: (p) => void consented.add(p) },
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('status', () => {
    it('is available when the manifest, token and health all answer', async () => {
      replies.push(json(200, { ok: true, provider: 'gptzero' }));
      expect(await detectorStatus(deps)).toEqual({
        available: true,
        provider: 'gptzero',
        dataLeaves: MANIFEST.store.dataLeaves,
        consented: false,
      });
      expect(calls[0].url).toBe('http://127.0.0.1:8790/health');
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    });

    it('uses DETECTOR_PORT from the stack .env', async () => {
      fs.writeFileSync(path.join(root, '.env'), 'DETECTOR_PORT=9123\n');
      replies.push(json(200, { ok: true, provider: 'pangram' }));
      await detectorStatus(deps);
      expect(calls[0].url).toBe('http://127.0.0.1:9123/health');
    });

    it('says whether this provider was already agreed to', async () => {
      consented.add('pangram');
      replies.push(json(200, { ok: true, provider: 'pangram' }));
      expect(await detectorStatus(deps)).toMatchObject({ available: true, consented: true });
    });

    it.each([
      ['no stack', () => (deps.stackRoot = () => null)],
      ['a stack without the add-on', () => fs.rmSync(path.join(root, 'addons'), { recursive: true })],
      ['no token file', () => fs.rmSync(tokenPath())],
      ['a health check that fails', () => replies.push(new TypeError('fetch failed'))],
      ['an unknown provider', () => replies.push(json(200, { ok: true, provider: 'other' }))],
    ])('is unavailable with %s, without asking anything', async (_label, arrange) => {
      arrange();
      expect(await detectorStatus(deps)).toEqual({ available: false });
    });
  });

  describe('check', () => {
    it('posts the text with the token and returns the score', async () => {
      replies.push(
        json(200, {
          provider: 'pangram',
          score: 0.82,
          label: 'AI',
          model: 'v3',
          segments: [
            { start: 0, end: 10, score: 0.9 },
            { start: 5, end: 'x'.length + 10_000, score: 0.5 },
          ],
          checkedAt: '2026-11-12T10:00:00Z',
        })
      );
      const result = await checkWithDetector(TEXT, deps);
      expect(calls[0].url).toBe('http://127.0.0.1:8790/check');
      expect(calls[0].init.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: TEXT });
      expect(result).toEqual({
        ok: true,
        score: {
          provider: 'pangram',
          score: 0.82,
          label: 'AI',
          model: 'v3',
          // A segment past the end of the text is dropped.
          segments: [{ start: 0, end: 10, score: 0.9 }],
          checkedAt: '2026-11-12T10:00:00Z',
        },
      });
    });

    it.each([
      [422, 'too_short'],
      [413, 'too_long'],
      [409, 'no_key'],
      [502, 'provider_error'],
      [504, 'timeout'],
      [400, 'bad_input'],
      [403, 'forbidden'],
    ])('passes on a %i as %s with the add-on’s message', async (status, code) => {
      replies.push(json(status, { error: { code, message: `the ${code} message` } }));
      expect(await checkWithDetector(TEXT, deps)).toEqual({
        ok: false,
        error: { code, message: `the ${code} message` },
      });
    });

    it('keeps retryAfter on quota', async () => {
      replies.push(json(429, { error: { code: 'quota', message: 'Out of credits.', retryAfter: 30 } }, { 'Retry-After': '30' }));
      expect(await checkWithDetector(TEXT, deps)).toEqual({
        ok: false,
        error: { code: 'quota', message: 'Out of credits.', retryAfter: 30 },
      });
    });

    it('reads the token again once after a 401, for a rotated token', async () => {
      replies.push(json(401, { error: { code: 'unauthorized', message: 'a valid bearer token is required' } }));
      replies.push(json(200, { provider: 'gptzero', score: 0.1, segments: [], checkedAt: '2026-11-12T10:00:00Z' }));
      const first = deps.fetch;
      deps.fetch = (async (url: string, init?: RequestInit) => {
        fs.writeFileSync(tokenPath(), 'b'.repeat(64));
        return first(url, init);
      }) as typeof fetch;
      const result = await checkWithDetector(TEXT, deps);
      expect(result.ok).toBe(true);
      expect((calls[1].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${'b'.repeat(64)}`);
    });

    it('stops after a second 401', async () => {
      replies.push(json(401, { error: { code: 'unauthorized', message: 'no' } }));
      replies.push(json(401, { error: { code: 'unauthorized', message: 'no' } }));
      const result = await checkWithDetector(TEXT, deps);
      expect(result).toEqual({
        ok: false,
        error: { code: 'unauthorized', message: 'The detector add-on refused Boundary’s token.' },
      });
      expect(calls).toHaveLength(2);
    });

    it('says the add-on isn’t answering when nothing listens', async () => {
      replies.push(new TypeError('fetch failed'));
      expect(await checkWithDetector(TEXT, deps)).toEqual({
        ok: false,
        error: { code: 'unavailable', message: 'The detector add-on isn’t answering. Is the stack running?' },
      });
    });

    it('says so when the add-on doesn’t answer in time', async () => {
      replies.push(new DOMException('The operation timed out.', 'TimeoutError'));
      expect(await checkWithDetector(TEXT, deps)).toEqual({
        ok: false,
        error: { code: 'timeout', message: 'The detector add-on didn’t answer in time.' },
      });
    });

    it('treats an unreadable answer as a provider error', async () => {
      replies.push(new Response('<html>', { status: 200 }));
      const result = await checkWithDetector(TEXT, deps);
      expect(result).toMatchObject({ ok: false, error: { code: 'provider_error' } });
    });

    it('logs the outcome without the text or token', async () => {
      replies.push(json(422, { error: { code: 'too_short', message: 'short' } }));
      await checkWithDetector(TEXT, deps);
      const [area, message, data] = log.mock.calls.at(-1) ?? [];
      expect(area).toBe('writing-check');
      expect(message).toBe('detector check');
      expect(data).toMatchObject({ outcome: 'too_short', status: 422, chars: TEXT.length });
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/word word|aaaa/);
    });
  });
});
