import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ storeData: {} as Record<string, unknown> }));

vi.mock('electron-store', () => ({
  default: class {
    constructor(opts: { defaults: Record<string, unknown> }) {
      Object.assign(h.storeData, structuredClone(opts.defaults));
    }
    get(key: string) {
      return structuredClone(h.storeData[key]);
    }
    set(key: string, value: unknown) {
      h.storeData[key] = structuredClone(value);
    }
  },
}));

import { getInstalledAddons, setAddonInstalled } from '../AssistantStackStore';

const LOCAL = '/Users/dev/assistant-twenty-crm';
const MANAGED = '/Users/dev/Library/Application Support/Boundary/assistant-stack/project';

describe('installed add-ons in the stack store', () => {
  beforeEach(() => {
    for (const key of Object.keys(h.storeData)) delete h.storeData[key];
  });

  it('keeps each stack root its own list', () => {
    setAddonInstalled(LOCAL, 'twenty', true);
    expect(getInstalledAddons(LOCAL)).toEqual(['twenty']);
    expect(getInstalledAddons(MANAGED)).toEqual([]);

    setAddonInstalled(MANAGED, 'twenty', true);
    setAddonInstalled(LOCAL, 'twenty', false);
    expect(getInstalledAddons(LOCAL)).toEqual([]);
    expect(getInstalledAddons(MANAGED)).toEqual(['twenty']);
  });

  it('keys roots that contain dots as whole paths', () => {
    const dotted = '/Users/dev/.claude/worktrees/stack.v2';
    setAddonInstalled(dotted, 'twenty', true);
    expect(getInstalledAddons(dotted)).toEqual(['twenty']);
    expect(getInstalledAddons('/Users/dev/')).toEqual([]);
  });

  it('drops the list stored before installs were keyed by root', () => {
    h.storeData.installedAddons = ['twenty'];
    expect(getInstalledAddons(LOCAL)).toEqual([]);
    expect(getInstalledAddons(MANAGED)).toEqual([]);
  });

  it('leaves out ids this build has no add-on for', () => {
    h.storeData.installedAddonsByRoot = { [MANAGED]: ['calendar-pro', 'twenty'] };
    expect(getInstalledAddons(MANAGED)).toEqual(['twenty']);
  });
});
