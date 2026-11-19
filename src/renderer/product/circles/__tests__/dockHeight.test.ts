import { beforeEach, describe, expect, it } from 'vitest';
import { AREA_MIN_PX, DOCK_DEFAULT_PX, DOCK_MIN_PX, ROW_PX, clampDockHeight, dockRowCount, readDockHeight, saveDockHeight } from '../dockHeight';

describe('the dock height', () => {
  beforeEach(() => window.localStorage.clear());

  it('defaults to six rows', () => expect(readDockHeight()).toBe(286));
  it('reads what was saved', () => {
    saveDockHeight(320);
    expect(readDockHeight()).toBe(320);
  });
  it('ignores junk in storage', () => {
    window.localStorage.setItem('boundary:circles-dock-height', '"tall"');
    expect(readDockHeight()).toBe(286);
  });
  it('keeps the wanted height when both parts fit', () => expect(clampDockHeight(286, 700)).toBe(286));
  it('leaves the Circle area four rows', () => expect(clampDockHeight(600, 700)).toBe(486));
  it('never goes below three rows', () => expect(clampDockHeight(100, 700)).toBe(181));
  it('keeps three rows in a rail too short for both', () => expect(clampDockHeight(286, 300)).toBe(181));
  it('is built from rows of 35px', () => {
    expect(ROW_PX).toBe(35);
    expect(DOCK_DEFAULT_PX).toBe(286);
    expect(DOCK_MIN_PX).toBe(181);
    expect(AREA_MIN_PX).toBe(214);
  });
  it('counts the rows a dock height shows', () => {
    expect(dockRowCount(DOCK_DEFAULT_PX)).toBe(6);
    expect(dockRowCount(DOCK_MIN_PX)).toBe(3);
  });
});
