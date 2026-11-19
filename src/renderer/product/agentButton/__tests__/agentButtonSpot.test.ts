import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SPOT,
  isBottomRight,
  nearestSpot,
  resetAgentButtonSpotForTests,
  saveAgentButtonSpot,
  spotStyle,
  useAgentButtonSpot,
} from '../agentButtonSpot';

describe('the agent button’s spot', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetAgentButtonSpotForTests();
  });
  afterEach(() => resetAgentButtonSpotForTests());

  it('snaps to the nearest edge, at the matching place along it', () => {
    // A 1000×700 area: the centre near the left, a third of the way down.
    const spot = nearestSpot(30, 300, 1000, 700);
    expect(spot.edge).toBe('left');
    expect(spot.along).toBeCloseTo((300 - 52 - 30) / (700 - 52 - 16 - 60));
    expect(nearestSpot(500, 680, 1000, 700)).toEqual({ edge: 'bottom', along: expect.closeTo(0.5, 2) });
  });

  it('counts a drop close to an end as the corner', () => {
    expect(nearestSpot(960, 690, 1000, 700)).toEqual({ edge: 'bottom', along: 1 });
    expect(nearestSpot(80, 60, 1000, 700)).toEqual({ edge: 'top', along: 0 });
    expect(isBottomRight(nearestSpot(960, 690, 1000, 700))).toBe(true);
    expect(isBottomRight({ edge: 'right', along: 1 })).toBe(true);
    expect(isBottomRight({ edge: 'bottom', along: 0.5 })).toBe(false);
  });

  it('places the button by proportion, so it keeps its place at any size', () => {
    expect(spotStyle(DEFAULT_SPOT)).toEqual({ bottom: '16px', left: 'calc(16px + 1 * (100% - 92px))' });
    expect(spotStyle({ edge: 'left', along: 0 })).toEqual({ left: '16px', top: 'calc(52px + 0 * (100% - 128px))' });
  });

  it('remembers where it was dropped, and ignores a stored value it can’t read', () => {
    saveAgentButtonSpot({ edge: 'top', along: 1.4 });
    expect(window.localStorage.getItem('boundary:agent-button')).toBe('{"edge":"top","along":1}');
    resetAgentButtonSpotForTests();
    expect(renderHook(() => useAgentButtonSpot()).result.current).toEqual({ edge: 'top', along: 1 });
    window.localStorage.setItem('boundary:agent-button', '{"edge":"middle","along":2}');
    resetAgentButtonSpotForTests();
    expect(renderHook(() => useAgentButtonSpot()).result.current).toEqual(DEFAULT_SPOT);
  });
});
