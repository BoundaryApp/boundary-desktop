import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { resetIpcStoresForTests } from '../../../lib/ipcStore';
import type { ConfidentialState } from '../../../../shared/types/confidentialState';
import { useConfidentialState } from '../useConfidentialState';

type Listener = (state: ConfidentialState) => void;

function installBridge(initial: ConfidentialState) {
  let listener: Listener | null = null;
  const confidential = {
    getState: vi.fn().mockResolvedValue(initial),
    addProvider: vi.fn().mockResolvedValue({ added: true, checks: [] }),
    removeProvider: vi.fn().mockResolvedValue(initial),
    setSettings: vi.fn().mockResolvedValue(initial),
    rank: vi.fn().mockResolvedValue(null),
    onState: (callback: Listener): (() => void) => {
      listener = callback;
      return () => undefined;
    },
  };
  stubElectronAPI({ confidential });
  return { confidential, emit: (state: ConfidentialState) => listener?.(state) };
}

describe('useConfidentialState', () => {
  beforeEach(() => resetIpcStoresForTests());
  afterEach(() => installElectronAPI());

  it('loads the state, then follows onState events', async () => {
    const bridge = installBridge({ enabled: false });
    const { result } = renderHook(() => useConfidentialState());
    expect(result.current.state).toBeNull();
    await waitFor(() => expect(result.current.state).toEqual({ enabled: false }));
    const next = { enabled: true, providers: [] } as unknown as ConfidentialState;
    act(() => bridge.emit(next));
    expect(result.current.state).toBe(next);
  });

  it('passes addProvider, removeProvider, setSettings and rank to main', async () => {
    const bridge = installBridge({ enabled: false });
    const { result } = renderHook(() => useConfidentialState());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await expect(result.current.addProvider('acme', 'k')).resolves.toEqual({ added: true, checks: [] });
    expect(bridge.confidential.addProvider).toHaveBeenCalledWith({ id: 'acme', apiKey: 'k' });
    await result.current.removeProvider('acme');
    expect(bridge.confidential.removeProvider).toHaveBeenCalledWith({ id: 'acme' });
    const settings = { order: 'cheapest' } as never;
    await result.current.setSettings(settings);
    expect(bridge.confidential.setSettings).toHaveBeenCalledWith(settings);
    await result.current.rank('m1', { privateProject: false });
    expect(bridge.confidential.rank).toHaveBeenCalledWith({ modelId: 'm1', privateProject: false });
  });
});
