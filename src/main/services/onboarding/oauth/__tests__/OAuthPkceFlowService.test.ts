import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ shell: { openExternal } }));
vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

import { cancelActiveOAuthPkceFlow, startOAuthPkceFlow } from '../OAuthPkceFlowService';
import { openRouterOAuthProvider } from '../OpenRouterOAuthProvider';

const callbackFrom = (authUrl: string) => new URL(authUrl).searchParams.get('callback_url') ?? '';

describe('startOAuthPkceFlow', () => {
  beforeEach(() => {
    openExternal.mockReset();
    vi.spyOn(openRouterOAuthProvider, 'exchangeCode').mockResolvedValue({ apiKey: 'sk-or-test' });
  });

  it('has the callback listening before the browser opens', async () => {
    openExternal.mockImplementation(async (authUrl: string) => {
      const response = await fetch(`${callbackFrom(authUrl)}/?code=instant`);
      expect(response.status).toBe(200);
    });

    const result = await startOAuthPkceFlow('openrouter');

    expect(result.apiKey).toBe('sk-or-test');
    expect(vi.mocked(openRouterOAuthProvider.exchangeCode).mock.calls[0][0].code).toBe('instant');
  });

  it('closes the listener when the browser can’t open', async () => {
    let callback = '';
    openExternal.mockImplementation(async (authUrl: string) => {
      callback = callbackFrom(authUrl);
      throw new Error('no browser');
    });

    await expect(startOAuthPkceFlow('openrouter')).rejects.toThrow('no browser');
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('cancels a sign-in that is waiting for the browser', async () => {
    openExternal.mockResolvedValue(undefined);
    const flow = startOAuthPkceFlow('openrouter');
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());

    cancelActiveOAuthPkceFlow();

    await expect(flow).rejects.toThrow('cancelled');
  });
});
