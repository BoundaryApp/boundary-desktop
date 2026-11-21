import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BUSY_SEND_STORAGE_KEY, readBusySendPref, resetBusySendPrefForTests, useBusySendPref } from '../busySendPref';

afterEach(() => {
  window.localStorage.removeItem(BUSY_SEND_STORAGE_KEY);
  resetBusySendPrefForTests();
});

describe('busySendPref (run-control spec 2.7)', () => {
  it('asks by default', () => {
    expect(readBusySendPref()).toBe('ask');
    expect(renderHook(() => useBusySendPref()).result.current[0]).toBe('ask');
  });

  it('stores Always queue for the next launch and updates every mounted control', () => {
    const menu = renderHook(() => useBusySendPref());
    const settings = renderHook(() => useBusySendPref());

    act(() => settings.result.current[1]('queue'));

    expect(window.localStorage.getItem(BUSY_SEND_STORAGE_KEY)).toBe('queue');
    expect(menu.result.current[0]).toBe('queue');
    // A fresh mount reads it back.
    expect(renderHook(() => useBusySendPref()).result.current[0]).toBe('queue');

    act(() => menu.result.current[1]('ask'));
    expect(settings.result.current[0]).toBe('ask');
  });

  it('loads Always queue saved unquoted, as earlier builds stored it', () => {
    window.localStorage.setItem(BUSY_SEND_STORAGE_KEY, 'queue');
    expect(renderHook(() => useBusySendPref()).result.current[0]).toBe('queue');
  });

  it('reads anything unexpected as ask', () => {
    window.localStorage.setItem(BUSY_SEND_STORAGE_KEY, 'sometimes');
    expect(readBusySendPref()).toBe('ask');
  });
});
