import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MANAGED = '/tmp/boundary-managed-project';
const CHECKOUT = '/tmp/dev-assistant-checkout';
const OTHER = '/tmp/other-assistant-checkout';

let storedOverride: string | null = null;
let storedLocation: unknown = undefined;
let managedRoot = MANAGED;

vi.mock('../AssistantStackStore', () => ({
  getAssistantRootOverride: () => storedOverride,
  getStoredStackHostLocation: () => storedLocation,
}));

vi.mock('../assistantPaths', () => ({
  resolveAssistantProjectRoot: () => managedRoot,
}));

import {
  isLocalAssistantStackMode,
  resetStackModeCacheForTests,
  stackMode,
  type StackMode,
} from '../localStackMode';
import {
  AssistantRootError,
  forgetAssistantRootChecks,
  resolveActiveAssistantRoot,
  resolveAssistantRoot,
  tryResolveAssistantRoot,
} from '../resolveAssistantRoot';
import { BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE } from '../../../../shared/assistantStackConstants';

describe('stackMode', () => {
  beforeEach(() => {
    vi.stubEnv('BOUNDARY_LOCAL_STACK', undefined);
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    storedOverride = null;
    resetStackModeCacheForTests();
  });

  afterEach(() => {
    resetStackModeCacheForTests();
  });

  // Each row once had up to four answers (isLocalAssistantStackMode,
  // hasExplicitAssistantRootOverride, tryAttachToLiveLocalStack's flag check and the stack
  // identity); now there is one.
  const cases: Array<{
    name: string;
    liveFlag?: boolean;
    envRoot?: string;
    stored?: string;
    expected: StackMode;
  }> = [
    {
      name: 'nothing set',
      expected: { kind: 'managed', root: MANAGED, source: 'managed', attachLive: false },
    },
    {
      // Was local for isLocal…, yet the managed install was provisioned and started.
      name: 'BOUNDARY_LOCAL_STACK=1 alone',
      liveFlag: true,
      expected: { kind: 'managed', root: MANAGED, source: 'managed', attachLive: false },
    },
    {
      name: 'BOUNDARY_ASSISTANT_ROOT alone',
      envRoot: CHECKOUT,
      expected: {
        kind: 'local',
        root: CHECKOUT,
        source: 'BOUNDARY_ASSISTANT_ROOT',
        attachLive: false,
      },
    },
    {
      name: 'dev:local-stack (flag and root)',
      liveFlag: true,
      envRoot: CHECKOUT,
      expected: {
        kind: 'local',
        root: CHECKOUT,
        source: 'BOUNDARY_ASSISTANT_ROOT',
        attachLive: true,
      },
    },
    {
      name: 'stored override',
      stored: CHECKOUT,
      expected: { kind: 'local', root: CHECKOUT, source: 'stored-override', attachLive: false },
    },
    {
      name: 'env root wins over the stored override',
      envRoot: CHECKOUT,
      stored: OTHER,
      expected: {
        kind: 'local',
        root: CHECKOUT,
        source: 'BOUNDARY_ASSISTANT_ROOT',
        attachLive: false,
      },
    },
    {
      // Was local for isLocal… and skipped provisioning, but managed for the identity.
      name: 'stored override naming the managed install',
      stored: MANAGED,
      expected: { kind: 'managed', root: MANAGED, source: 'stored-override', attachLive: false },
    },
    {
      name: 'env root naming the managed install, with the flag',
      liveFlag: true,
      envRoot: `${MANAGED}/`,
      expected: {
        kind: 'managed',
        root: MANAGED,
        source: 'BOUNDARY_ASSISTANT_ROOT',
        attachLive: false,
      },
    },
  ];

  it.each(cases)('$name', ({ liveFlag, envRoot, stored, expected }) => {
    if (liveFlag) vi.stubEnv('BOUNDARY_LOCAL_STACK', '1');
    if (envRoot) vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', envRoot);
    storedOverride = stored ?? null;
    expect(stackMode()).toEqual(expected);
    expect(isLocalAssistantStackMode()).toBe(expected.kind === 'local');
  });

  it('follows a change to the stored override', () => {
    expect(stackMode().kind).toBe('managed');
    storedOverride = CHECKOUT;
    expect(stackMode()).toMatchObject({ kind: 'local', root: CHECKOUT });
  });
});

describe('stackMode and resolveAssistantRoot', () => {
  let dir: string;

  beforeEach(() => {
    vi.stubEnv('BOUNDARY_LOCAL_STACK', undefined);
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stack-mode-')));
    managedRoot = path.join(dir, 'managed');
    fs.mkdirSync(managedRoot);
    fs.writeFileSync(path.join(managedRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), '');
    resetStackModeCacheForTests();
    forgetAssistantRootChecks();
  });

  afterEach(() => {
    managedRoot = MANAGED;
    storedOverride = null;
    storedLocation = undefined;
    resetStackModeCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // resolveAssistantRoot used to return the link while isBoundaryOwnedAssistantRoot compared it
  // with path.resolve, so a start provisioned the managed install and then skipped its setup.
  it('agree on a stored override reached through a symlink to the managed install', () => {
    const link = path.join(dir, 'link-to-managed');
    fs.symlinkSync(managedRoot, link);
    storedOverride = link;
    expect(stackMode()).toMatchObject({ kind: 'managed', root: link });
    expect(resolveAssistantRoot()).toBe(stackMode().root);
  });

  // Remote stack plan, phase 4d: code still on local paths fails by name rather than using the
  // managed install's folder on this computer.
  it('has no folder on this computer when the stored location is another computer', () => {
    storedLocation = { kind: 'ssh', host: 'pc.example.com', user: 'ana', key: { kind: 'agent' }, stackFolder: '/srv/stack' };
    expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
    expect(tryResolveAssistantRoot()).toEqual({
      root: null,
      error: 'The agent stack is on ana@pc.example.com, so it has no folder on this computer.',
    });
    expect(() => resolveActiveAssistantRoot()).toThrow('ana@pc.example.com');
  });

  it('treats a malformed stored location as remote, and BOUNDARY_ASSISTANT_ROOT as local', () => {
    storedLocation = { kind: 'ssh', host: 'pc.example.com' };
    expect(() => resolveActiveAssistantRoot()).toThrow('no user');
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', managedRoot);
    resetStackModeCacheForTests();
    expect(resolveAssistantRoot()).toBe(managedRoot);
  });
});
