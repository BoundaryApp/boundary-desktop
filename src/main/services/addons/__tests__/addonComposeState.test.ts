import { beforeEach, describe, expect, it, vi } from 'vitest';

const installed = vi.hoisted(() => ({
  ids: [] as string[],
  roots: [] as string[],
  root: '/stacks/active' as string | null,
  set: [] as unknown[][],
  lightrag: false,
}));

vi.mock('../../assistant/AssistantStackStore', () => ({
  getInstalledAddons: (root: string) => {
    installed.roots.push(root);
    return installed.ids;
  },
  setAddonInstalled: (...args: unknown[]) => void installed.set.push(args),
  isLightragEnabled: () => installed.lightrag,
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () =>
    installed.root ? { root: installed.root } : { root: null, error: 'no stack here' },
}));

import {
  addonComposeEnv,
  addonComposeProfiles,
  boundaryComposeProfileArgs,
  lightragComposeEnv,
  lightragComposeProfiles,
  setAddonInstalledHere,
} from '../addonComposeState';
import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES } from '../../../../shared/assistantStackConstants';

describe('addonComposeState', () => {
  beforeEach(() => {
    installed.ids = [];
    installed.roots = [];
    installed.root = '/stacks/active';
    installed.set = [];
    installed.lightrag = false;
  });

  it('records an install for the resolved root, and refuses without one', () => {
    setAddonInstalledHere('twenty', true);
    expect(installed.set).toEqual([['/stacks/active', 'twenty', true]]);
    installed.root = null;
    expect(() => setAddonInstalledHere('twenty', false)).toThrow('no stack here');
  });

  it('reads no add-ons while no stack root resolves', () => {
    installed.ids = ['twenty'];
    installed.root = null;
    expect(addonComposeProfiles()).toEqual([]);
    expect(installed.roots).toEqual([]);
  });

  it("reads the active stack root's list", () => {
    installed.ids = ['twenty'];
    addonComposeProfiles();
    addonComposeEnv();
    expect(installed.roots).toEqual(['/stacks/active', '/stacks/active']);
  });

  it('adds crm and the Twenty flags when Twenty is installed', () => {
    installed.ids = ['twenty'];
    expect(addonComposeProfiles()).toEqual(['crm']);
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' });
    expect(boundaryComposeProfileArgs()).toEqual(
      [...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, 'crm'].flatMap((p) => ['--profile', p]),
    );
  });

  it("sets both Twenty flags to 0 when it isn't", () => {
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
    expect(boundaryComposeProfileArgs()).toEqual(
      BOUNDARY_ASSISTANT_COMPOSE_PROFILES.flatMap((p) => ['--profile', p]),
    );
  });

  it('treats Twenty as not installed when nothing is stored, even mid-install', () => {
    installed.ids = [];
    expect(addonComposeProfiles()).toEqual([]);
    expect(addonComposeEnv()).toEqual({ TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' });
  });

  it('leaves rag out and turns the LightRAG flag off while LightRAG is off', () => {
    expect(BOUNDARY_ASSISTANT_COMPOSE_PROFILES).not.toContain('rag');
    expect(lightragComposeProfiles()).toEqual([]);
    expect(lightragComposeEnv()).toEqual({ LIGHTRAG_MCP_ENABLED: '0' });
  });

  it('adds rag before the add-ons and turns the flag on while LightRAG is on', () => {
    installed.lightrag = true;
    installed.ids = ['twenty'];
    expect(lightragComposeProfiles()).toEqual(['rag']);
    expect(lightragComposeEnv()).toEqual({ LIGHTRAG_MCP_ENABLED: '1' });
    expect(boundaryComposeProfileArgs()).toEqual(
      [...BOUNDARY_ASSISTANT_COMPOSE_PROFILES, 'rag', 'crm'].flatMap((p) => ['--profile', p]),
    );
  });
});
