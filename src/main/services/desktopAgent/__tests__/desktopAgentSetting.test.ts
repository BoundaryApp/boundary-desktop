import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  desktopAgentDefault,
  desktopAgentState,
  isDesktopAgentOn,
  onDesktopAgentChange,
  resetDesktopAgentListenersForTests,
  setDesktopAgentOn,
  type DesktopAgentBuild,
  type DesktopAgentStore,
} from '../desktopAgentSetting';

function memoryStore(initial?: boolean): DesktopAgentStore & { value: unknown } {
  const store = {
    value: initial as unknown,
    get: () => store.value,
    set: (_key: 'desktopAgentButton', value: boolean) => {
      store.value = value;
    },
  };
  return store;
}

const release: DesktopAgentBuild = { isPackaged: true, isSeparateInstance: false };
const testBuild: DesktopAgentBuild = { isPackaged: true, isSeparateInstance: true };
const unpackaged: DesktopAgentBuild = { isPackaged: false, isSeparateInstance: false };

beforeEach(() => resetDesktopAgentListenersForTests());

describe('desktopAgentDefault (ADR 0058 §17)', () => {
  it('defaults on unpackaged', () => {
    expect(desktopAgentDefault(unpackaged)).toBe(true);
  });

  it('defaults on for a build installed beside the default one', () => {
    expect(desktopAgentDefault(testBuild)).toBe(true);
  });

  it('defaults off for a packaged default build', () => {
    expect(desktopAgentDefault(release)).toBe(false);
  });
});

describe('isDesktopAgentOn', () => {
  it('reads the default while nothing is stored', () => {
    expect(isDesktopAgentOn(memoryStore(), 'darwin', release)).toBe(false);
    expect(isDesktopAgentOn(memoryStore(), 'darwin', testBuild)).toBe(true);
  });

  it('lets a stored value win over the default', () => {
    expect(isDesktopAgentOn(memoryStore(true), 'darwin', release)).toBe(true);
    expect(isDesktopAgentOn(memoryStore(false), 'darwin', testBuild)).toBe(false);
  });

  it('ignores a stored value that is not a boolean', () => {
    const store = memoryStore();
    store.value = 'yes';
    expect(isDesktopAgentOn(store, 'darwin', release)).toBe(false);
  });

  it.each(['linux', 'win32'] as const)('is off on %s whatever is stored (§16)', (platform) => {
    expect(isDesktopAgentOn(memoryStore(true), platform, testBuild)).toBe(false);
  });
});

describe('desktopAgentState', () => {
  it('is available on macOS only', () => {
    expect(desktopAgentState(memoryStore(), 'darwin', testBuild)).toEqual({ available: true, on: true });
    expect(desktopAgentState(memoryStore(true), 'linux', testBuild)).toEqual({ available: false, on: false });
  });
});

describe('setDesktopAgentOn', () => {
  it('stores the choice and tells listeners when it changes', () => {
    const store = memoryStore();
    const heard = vi.fn();
    const stop = onDesktopAgentChange(heard);
    setDesktopAgentOn(store, 'darwin', release, true);
    expect(store.value).toBe(true);
    expect(heard).toHaveBeenCalledWith(true);
    setDesktopAgentOn(store, 'darwin', release, true);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    setDesktopAgentOn(store, 'darwin', release, false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('stores nothing and tells no one off macOS', () => {
    const store = memoryStore();
    const heard = vi.fn();
    onDesktopAgentChange(heard);
    setDesktopAgentOn(store, 'linux', release, true);
    expect(store.value).toBeUndefined();
    expect(heard).not.toHaveBeenCalled();
  });
});
