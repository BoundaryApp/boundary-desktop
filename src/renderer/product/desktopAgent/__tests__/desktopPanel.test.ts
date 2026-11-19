import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetDesktopPanelForTests, setDesktopPanelTab, useDesktopPanelTab } from '../desktopPanel';

afterEach(() => {
  window.localStorage.clear();
  resetDesktopPanelForTests();
});

describe('the panel tab (ADR 0058 §6)', () => {
  it('starts on Agent and remembers the last tab on this Mac', () => {
    const { result } = renderHook(() => useDesktopPanelTab());
    expect(result.current).toBe('agent');
    act(() => setDesktopPanelTab('circles'));
    expect(result.current).toBe('circles');
    expect(window.localStorage.getItem('boundary:agent-panel-tab')).toBe('"circles"');
    resetDesktopPanelForTests();
    const again = renderHook(() => useDesktopPanelTab());
    expect(again.result.current).toBe('circles');
  });

  it('ignores a stored tab it does not know', () => {
    window.localStorage.setItem('boundary:agent-panel-tab', '"spaces"');
    const { result } = renderHook(() => useDesktopPanelTab());
    expect(result.current).toBe('agent');
  });
});
