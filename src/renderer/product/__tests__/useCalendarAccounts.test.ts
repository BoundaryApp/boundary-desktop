import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { useCalendarAccountList, useCalendarAccounts } from '../useCalendarAccounts';

const personal = { slug: 'personal', name: 'Personal' };

function calendars(list: ReturnType<typeof vi.fn>) {
  let changed: () => void = () => undefined;
  stubElectronAPI({
    calendars: {
      list,
      onChanged: vi.fn((cb: () => void) => {
        changed = cb;
        return () => undefined;
      }),
    },
  });
  return () => changed();
}

describe('useCalendarAccountList', () => {
  it('loads, then reloads on calendars:changed', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, accounts: [] });
    const changed = calendars(list);
    const { result } = renderHook(() => useCalendarAccounts());
    expect(result.current).toBeNull();
    await act(async () => undefined);
    expect(result.current).toEqual([]);
    list.mockResolvedValue({ success: true, accounts: [personal] });
    await act(async () => changed());
    expect(result.current).toEqual([personal]);
  });

  it('reports a failed load and keeps the last list', async () => {
    const list = vi.fn().mockResolvedValue({ success: true, accounts: [personal] });
    calendars(list);
    const { result } = renderHook(() => useCalendarAccountList());
    await act(async () => undefined);
    list.mockResolvedValue({ success: false, accounts: [], error: 'Keychain locked' });
    await act(async () => result.current.reload());
    expect(result.current.error).toBe('Keychain locked');
    expect(result.current.accounts).toEqual([personal]);
    list.mockRejectedValue(new Error('ipc'));
    await act(async () => result.current.reload());
    expect(result.current.error).toBe('Couldn’t load calendars.');
  });

  it('takes a list from another call', async () => {
    calendars(vi.fn().mockResolvedValue({ success: true, accounts: [] }));
    const { result } = renderHook(() => useCalendarAccountList());
    await act(async () => undefined);
    act(() => result.current.replace([personal] as never));
    expect(result.current.accounts).toEqual([personal]);
  });
});
