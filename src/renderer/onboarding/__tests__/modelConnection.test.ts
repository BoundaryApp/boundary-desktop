import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import type { OAuthPkceCredentialsBundle } from '../../../shared/types/onboarding';
import {
  adoptLocalLlm,
  connectionFromCredentials,
  keepOrFirstModel,
  testSlot,
  useOAuthSignIn,
} from '../modelConnection';

const credentials: OAuthPkceCredentialsBundle = {
  providerId: 'openrouter',
  providerDisplayName: 'OpenRouter',
  endpointUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test',
  authScheme: 'bearer',
  capabilities: { kind: 'oauth' } as OAuthPkceCredentialsBundle['capabilities'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('useOAuthSignIn', () => {
  it('reports connecting until main answers, then returns the credentials', async () => {
    const pending = deferred<{ success: boolean; credentials: OAuthPkceCredentialsBundle }>();
    stubElectronAPI({ onboarding: { startOAuthPkce: vi.fn().mockReturnValue(pending.promise) } });
    const { result } = renderHook(() => useOAuthSignIn('openrouter'));
    let outcome: unknown;
    let run!: Promise<void>;
    act(() => {
      run = result.current.signIn().then((o) => {
        outcome = o;
      });
    });
    expect(result.current.connecting).toBe(true);
    await act(async () => {
      pending.resolve({ success: true, credentials });
      await run;
    });
    expect(result.current.connecting).toBe(false);
    expect(outcome).toEqual({ kind: 'signed-in', credentials });
  });

  it('drops the answer after Cancel and tells main to stop', async () => {
    const pending = deferred<{ success: boolean; error: string }>();
    const cancelOAuthPkce = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({
      onboarding: { startOAuthPkce: vi.fn().mockReturnValue(pending.promise), cancelOAuthPkce },
    });
    const { result } = renderHook(() => useOAuthSignIn('openrouter'));
    let outcome: unknown;
    let run!: Promise<void>;
    act(() => {
      run = result.current.signIn().then((o) => {
        outcome = o;
      });
    });
    act(() => result.current.cancel());
    await act(async () => {
      pending.resolve({ success: false, error: 'cancelled' });
      await run;
    });
    expect(cancelOAuthPkce).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('returns the error of a failed sign-in, and does nothing without a provider', async () => {
    const startOAuthPkce = vi.fn().mockResolvedValue({ success: false, error: 'denied' });
    stubElectronAPI({ onboarding: { startOAuthPkce } });
    const { result } = renderHook(() => useOAuthSignIn('openrouter'));
    await act(async () => {
      expect(await result.current.signIn()).toEqual({ kind: 'failed', error: 'denied' });
    });
    const none = renderHook(() => useOAuthSignIn(undefined));
    await act(async () => {
      expect(await none.result.current.signIn()).toBeNull();
    });
    expect(startOAuthPkce).toHaveBeenCalledTimes(1);
  });
});

describe('connectionFromCredentials', () => {
  it('leaves the key and slot out unless asked', () => {
    const payload = connectionFromCredentials(credentials, 'm1', { slot: 'openrouter' });
    expect(payload).toMatchObject({ modelId: 'm1', provider: 'openrouter', slot: 'openrouter' });
    expect('apiKey' in payload).toBe(false);
    const withKey = connectionFromCredentials(credentials, 'm1', { withApiKey: true });
    expect(withKey).toMatchObject({ apiKey: 'sk-test' });
    expect('slot' in withKey).toBe(false);
  });
});

describe('model helpers', () => {
  it('keeps the saved model when listed, else the first', () => {
    const models = [{ id: 'a' }, { id: 'b' }];
    expect(keepOrFirstModel(models, 'b')).toBe('b');
    expect(keepOrFirstModel(models, 'gone')).toBe('a');
    expect(keepOrFirstModel([], 'x', 'fallback')).toBe('fallback');
  });

  it('adopts a local server and tests a slot with the shared message', async () => {
    const adopt = vi.fn().mockResolvedValue({ success: true });
    const send = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({ onboarding: { adoptLocalLlm: adopt, sendLlmTestMessage: send } });
    await adoptLocalLlm({ runtime: 'ollama', baseUrl: 'http://localhost:11434/v1' } as never, 'q');
    expect(adopt).toHaveBeenCalledWith({
      runtime: 'ollama',
      endpointUrl: 'http://localhost:11434/v1',
      modelId: 'q',
    });
    await testSlot('local');
    expect(send).toHaveBeenCalledWith({ slot: 'local', message: 'Reply with the word ready.' });
  });
});
