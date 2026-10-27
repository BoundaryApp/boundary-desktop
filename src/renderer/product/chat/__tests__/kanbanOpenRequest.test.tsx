import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

stubElectronAPI({
  kanban: {
    snapshot: () => Promise.resolve({ available: false, tasks: [], checkedAt: 0 }),
  },
});

import {
  clearTaskOpenRequest,
  requestTaskOpenForTests,
  useTaskOpenRequest,
} from '../kanbanActivity';

describe('task open requests (notification clicks)', () => {
  it('holds the clicked task until the chat screen takes it, and counts a repeat click', () => {
    const { result } = renderHook(() => useTaskOpenRequest());
    expect(result.current).toBeNull();
    act(() => requestTaskOpenForTests('t_1'));
    const first = result.current;
    expect(first?.taskId).toBe('t_1');

    act(() => clearTaskOpenRequest(first!.seq));
    expect(result.current).toBeNull();

    act(() => requestTaskOpenForTests('t_1'));
    expect(result.current?.seq).toBeGreaterThan(first!.seq);
    // A stale clear (an older click) leaves the newer request alone.
    act(() => clearTaskOpenRequest(first!.seq));
    expect(result.current?.taskId).toBe('t_1');
  });
});
