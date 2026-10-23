import { describe, expect, it } from 'vitest';
import { startOAuthLoopbackServer } from '../OAuthLoopbackServer';

describe('OAuthLoopbackServer', () => {
  it('captures an authorization code from the callback URL', async () => {
    const { port, waitForCode } = await startOAuthLoopbackServer({ timeoutMs: 5_000 });

    const resultPromise = waitForCode();
    await fetch(`http://127.0.0.1:${port}/?code=test-auth-code`);
    const result = await resultPromise;

    expect(result.code).toBe('test-auth-code');
    expect(result.port).toBe(port);
  });
});
