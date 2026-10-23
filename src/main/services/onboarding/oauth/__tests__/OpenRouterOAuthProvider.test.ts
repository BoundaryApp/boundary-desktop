import { describe, expect, it, vi } from 'vitest';
import { openRouterOAuthProvider } from '../OpenRouterOAuthProvider';

describe('OpenRouterOAuthProvider', () => {
  it('builds an auth URL with PKCE parameters', () => {
    const url = openRouterOAuthProvider.buildAuthUrl({
      callbackUrl: 'http://127.0.0.1:8976',
      codeChallenge: 'abc123',
    });
    expect(url).toContain('https://openrouter.ai/auth?');
    expect(url).toContain('callback_url=http%3A%2F%2F127.0.0.1%3A8976');
    expect(url).toContain('code_challenge=abc123');
    expect(url).toContain('code_challenge_method=S256');
  });

  it('exchanges an authorization code for an API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ key: 'sk-or-test-key' }),
    });

    const result = await openRouterOAuthProvider.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      fetchImpl,
    });

    expect(result.apiKey).toBe('sk-or-test-key');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/auth/keys',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          code: 'auth-code',
          code_verifier: 'verifier',
          code_challenge_method: 'S256',
        }),
      })
    );
  });
});
