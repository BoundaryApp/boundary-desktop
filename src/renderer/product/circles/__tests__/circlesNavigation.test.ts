import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { circleChannel, openCircle, rememberChannel, resetCirclesOpenForTests, useCirclesOpen } from '../circlesNavigation';

const commands = vi.hoisted(() => ({ dispatchAppCommand: vi.fn() }));
vi.mock('../../useAppShortcuts', () => commands);

afterEach(() => {
  window.localStorage.clear();
  resetCirclesOpenForTests();
  commands.dispatchAppCommand.mockReset();
});

describe('rememberChannel (ADR 0058 §13)', () => {
  it('records the channel last open in a Circle without moving the Circles screen or going there', () => {
    openCircle('k1');
    commands.dispatchAppCommand.mockReset();
    const { result } = renderHook(() => useCirclesOpen());
    act(() => rememberChannel('k2', 'garden'));
    expect(result.current.open).toEqual({ kind: 'circle', key: 'k1' });
    expect(circleChannel(result.current, 'k2')).toBe('garden');
    expect(commands.dispatchAppCommand).not.toHaveBeenCalled();
    resetCirclesOpenForTests();
    const again = renderHook(() => useCirclesOpen());
    expect(circleChannel(again.result.current, 'k2')).toBe('garden');
  });
});
