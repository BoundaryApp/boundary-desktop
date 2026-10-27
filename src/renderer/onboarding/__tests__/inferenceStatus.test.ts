import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { emptyInferenceProvidersStatus } from '../../../shared/types/onboarding';
import type { InferenceProvidersStatus } from '../../../shared/types/onboarding';
import {
  getInferenceStatus,
  refreshInferenceStatus,
  takeInferenceStatus,
  useInferenceStatus,
} from '../inferenceStatus';

const local: InferenceProvidersStatus = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local',
  slots: { local: { configured: true, modelId: 'qwen3:14b' } },
};
const openrouter: InferenceProvidersStatus = { ...local, appDefault: 'openrouter' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('inference status store', () => {
  it('fetches once for every reader', async () => {
    const getStatus = vi.fn().mockResolvedValue(local);
    stubElectronAPI({ onboarding: { getStatus } });
    const a = renderHook(() => useInferenceStatus());
    const b = renderHook(() => useInferenceStatus());
    expect(a.result.current.loading).toBe(true);
    await act(async () => undefined);
    expect(a.result.current.status).toBe(local);
    expect(b.result.current.status).toBe(local);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('takes the status main pushes when a slot health changes', async () => {
    let push: (status: InferenceProvidersStatus) => void = () => undefined;
    const getStatus = vi.fn().mockResolvedValue(local);
    stubElectronAPI({
      onboarding: {
        getStatus,
        onStatus: (cb: typeof push) => {
          push = cb;
          return () => undefined;
        },
      },
    });
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => undefined);
    await act(async () => push(openrouter));
    expect(result.current.status).toBe(openrouter);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('takes the status a mutation returned without fetching', async () => {
    const getStatus = vi.fn().mockResolvedValue(local);
    stubElectronAPI({ onboarding: { getStatus } });
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => undefined);
    await act(async () => takeInferenceStatus({ status: openrouter }));
    expect(result.current.status).toBe(openrouter);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('does not fetch at start when a result arrived before the first reader', async () => {
    const getStatus = vi.fn().mockResolvedValue(local);
    stubElectronAPI({ onboarding: { getStatus } });
    await takeInferenceStatus({ status: openrouter });
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => undefined);
    expect(result.current.status).toBe(openrouter);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('fetches when a mutation result has no status', async () => {
    const getStatus = vi.fn().mockResolvedValue(local);
    stubElectronAPI({ onboarding: { getStatus } });
    await takeInferenceStatus({});
    expect(getInferenceStatus()).toBe(local);
    expect(getStatus).toHaveBeenCalledTimes(1);
  });

  it('drops a fetch answer that a newer mutation result overtook', async () => {
    const slow = deferred<InferenceProvidersStatus>();
    stubElectronAPI({ onboarding: { getStatus: vi.fn(() => slow.promise) } });
    const pending = refreshInferenceStatus();
    await takeInferenceStatus({ status: openrouter });
    slow.resolve(local);
    await pending;
    expect(getInferenceStatus()).toBe(openrouter);
  });

  it('reports a failed fetch with an empty status', async () => {
    stubElectronAPI({ onboarding: { getStatus: vi.fn().mockRejectedValue(new Error('no store')) } });
    const { result } = renderHook(() => useInferenceStatus());
    await act(async () => undefined);
    expect(result.current.error).toBe('no store');
    expect(result.current.status).toEqual(emptyInferenceProvidersStatus(false));
  });
});
