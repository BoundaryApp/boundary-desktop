import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MANAGED = '/tmp/boundary-managed-project';
const CHECKOUT = '/tmp/dev-assistant-checkout';
const OTHER = '/tmp/other-assistant-checkout';

let storedOverride: string | null = null;

vi.mock('../AssistantStackStore', () => ({
  getAssistantRootOverride: () => storedOverride,
}));

vi.mock('../assistantPaths', () => ({
  resolveAssistantProjectRoot: () => MANAGED,
}));

import {
  isLocalAssistantStackMode,
  resetStackModeCacheForTests,
  stackMode,
  type StackMode,
} from '../localStackMode';

describe('stackMode', () => {
  const prevLocal = process.env.BOUNDARY_LOCAL_STACK;
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;

  beforeEach(() => {
    delete process.env.BOUNDARY_LOCAL_STACK;
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    storedOverride = null;
    resetStackModeCacheForTests();
  });

  afterEach(() => {
    if (prevLocal === undefined) delete process.env.BOUNDARY_LOCAL_STACK;
    else process.env.BOUNDARY_LOCAL_STACK = prevLocal;
    if (prevRoot === undefined) delete process.env.BOUNDARY_ASSISTANT_ROOT;
    else process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
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
    if (liveFlag) process.env.BOUNDARY_LOCAL_STACK = '1';
    if (envRoot) process.env.BOUNDARY_ASSISTANT_ROOT = envRoot;
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
