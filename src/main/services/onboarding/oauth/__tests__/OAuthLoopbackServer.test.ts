import { afterEach, describe, expect, it, vi } from 'vitest';

const persistDebugLog = vi.hoisted(() => vi.fn());
vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog }));

import { startOAuthLoopbackServer } from '../OAuthLoopbackServer';

const refused = (port: number) => fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true);

describe('OAuthLoopbackServer', () => {
  afterEach(() => {
    vi.useRealTimers();
    persistDebugLog.mockClear();
  });

  it('captures an authorization code from the callback URL', async () => {
    const { port, waitForCode } = await startOAuthLoopbackServer();

    await fetch(`http://127.0.0.1:${port}/?code=test-auth-code`);
    const result = await waitForCode();

    expect(result.code).toBe('test-auth-code');
    expect(result.port).toBe(port);
    expect(await refused(port)).toBe(true);
  });

  it('accepts a callback that arrives before anything waits for it', async () => {
    const { port, waitForCode } = await startOAuthLoopbackServer();

    const response = await fetch(`http://127.0.0.1:${port}/?code=early`);

    expect(response.status).toBe(200);
    expect((await waitForCode()).code).toBe('early');
  });

  it('keeps waiting through a request with no code', async () => {
    const { port, waitForCode, close } = await startOAuthLoopbackServer();

    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(response.status).toBe(400);

    await fetch(`http://127.0.0.1:${port}/?code=after-favicon`);
    expect((await waitForCode()).code).toBe('after-favicon');
    close();
  });

  it('stays up for a slow sign-in and gives up at OpenRouter’s 10-minute code lifetime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port, waitForCode } = await startOAuthLoopbackServer();
    const outcome = waitForCode().catch((error: Error) => error.message);

    vi.advanceTimersByTime(9 * 60_000);
    expect(await refused(port)).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(await outcome).toBe('OAuth authorization timed out. Try again.');
    expect(await refused(port)).toBe(true);
    expect(persistDebugLog).toHaveBeenCalledWith(
      'oauth',
      'callback wait timed out',
      expect.objectContaining({ port, requests: 1 })
    );
  });

  it('closes when cancelled, even before anything waits', async () => {
    const abort = new AbortController();
    const { port, waitForCode } = await startOAuthLoopbackServer({ signal: abort.signal });

    abort.abort();

    await expect(waitForCode()).rejects.toThrow('cancelled');
    expect(await refused(port)).toBe(true);
  });

  it('starts cancelled when the signal has already fired', async () => {
    const abort = new AbortController();
    abort.abort();
    const { waitForCode } = await startOAuthLoopbackServer({ signal: abort.signal });

    await expect(waitForCode()).rejects.toThrow('cancelled');
  });

  it('logs the parameter names of a callback and never the code', async () => {
    const { port, waitForCode } = await startOAuthLoopbackServer();

    await fetch(`http://127.0.0.1:${port}/?code=secret-code-value&state=secret-state`);
    await waitForCode();

    expect(persistDebugLog).toHaveBeenCalledWith(
      'oauth',
      'callback request',
      expect.objectContaining({ pathname: '/', params: ['code', 'state'] })
    );
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('secret');
  });
});
