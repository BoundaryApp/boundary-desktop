import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type {
  AssistantStackLifecycleSnapshot,
  AssistantStackStatus,
} from '../../../shared/types/assistantStack';
import {
  STACK_START_FAILED,
  useAssistantStackLifecycle,
  useAssistantStackStatus,
  useAssistantStackStatusLoaded,
  useStackStart,
} from '../assistantStack';

const status = (ready: boolean) => ({ setupComplete: true, ready }) as AssistantStackStatus;

function stack(stubs: Record<string, unknown> = {}) {
  let push: (snapshot: AssistantStackLifecycleSnapshot) => void = () => undefined;
  const api = {
    getStatus: vi.fn().mockResolvedValue(status(false)),
    getLifecycle: vi.fn().mockResolvedValue(createLifecycleSnapshot('idle')),
    onLifecycle: vi.fn((cb: typeof push) => {
      push = cb;
      return () => undefined;
    }),
    ...stubs,
  };
  stubElectronAPI({ assistantStack: api });
  return { api, push: (s: AssistantStackLifecycleSnapshot) => push(s) };
}

describe('assistant stack store', () => {
  it('shares one subscription and refetches the status when the phase changes', async () => {
    const { api, push } = stack();
    const reader = renderHook(() => ({
      lifecycle: useAssistantStackLifecycle(),
      status: useAssistantStackStatus(),
      loaded: useAssistantStackStatusLoaded(),
    }));
    renderHook(() => useAssistantStackLifecycle());
    expect(reader.result.current.loaded).toBe(false);
    await act(async () => undefined);
    expect(reader.result.current.loaded).toBe(true);
    expect(reader.result.current.status?.ready).toBe(false);
    expect(api.onLifecycle).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledTimes(1);

    api.getStatus.mockResolvedValue(status(true));
    await act(async () => push(createLifecycleSnapshot('ready')));
    expect(reader.result.current.lifecycle.phase).toBe('ready');
    expect(reader.result.current.status?.ready).toBe(true);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it('refetches the status when main sees the health check change, and not when it already shows it', async () => {
    let ready: (value: boolean) => void = () => undefined;
    const { api } = stack({
      onReady: vi.fn((cb: typeof ready) => {
        ready = cb;
        return () => undefined;
      }),
    });
    const { result } = renderHook(() => useAssistantStackStatus());
    await act(async () => undefined);
    expect(api.getStatus).toHaveBeenCalledTimes(1);

    await act(async () => ready(false));
    expect(api.getStatus).toHaveBeenCalledTimes(1);

    api.getStatus.mockResolvedValue(status(true));
    await act(async () => ready(true));
    expect(result.current?.ready).toBe(true);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps a pushed lifecycle over a slower initial answer', async () => {
    let answer!: (s: AssistantStackLifecycleSnapshot) => void;
    const { push } = stack({ getLifecycle: vi.fn(() => new Promise((r) => (answer = r))) });
    const { result } = renderHook(() => useAssistantStackLifecycle());
    await act(async () => push(createLifecycleSnapshot('starting')));
    await act(async () => answer(createLifecycleSnapshot('idle')));
    expect(result.current.phase).toBe('starting');
  });
});

describe('useStackStart', () => {
  it('takes the status the start returns', async () => {
    const ensureAndApplyLlm = vi.fn().mockResolvedValue({ success: true, status: status(true) });
    const { api } = stack({ ensureAndApplyLlm });
    const { result } = renderHook(() => ({ start: useStackStart(), status: useAssistantStackStatus() }));
    await act(async () => undefined);
    await act(async () => {
      await result.current.start.start();
    });
    expect(result.current.status?.ready).toBe(true);
    expect(result.current.start.error).toBeNull();
    expect(api.getStatus).toHaveBeenCalledTimes(1);
  });

  it('names a failure that came without an error, and refetches when no status came back', async () => {
    const ensureRunning = vi.fn().mockResolvedValue({ success: false });
    const { api } = stack({ ensureRunning });
    const { result } = renderHook(() => useStackStart());
    await act(async () => {
      expect(await result.current.start('ensureRunning')).toBe(false);
    });
    expect(ensureRunning).toHaveBeenCalled();
    expect(result.current.error).toBe(STACK_START_FAILED);
    expect(result.current.running).toBe(false);
    expect(api.getStatus).toHaveBeenCalled();
  });

  it('keeps the message of a start that threw', async () => {
    stack({ ensureAndApplyLlm: vi.fn().mockRejectedValue(new Error('compose exited 1')) });
    const { result } = renderHook(() => useStackStart());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBe('compose exited 1');
  });
});
