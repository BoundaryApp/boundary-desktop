import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeAssistantStackIdentity,
  hermesAgentsStoreName,
  resetAssistantStackIdentityCacheForTests,
} from '../assistantStackIdentity';
import { resolveAssistantProjectRoot } from '../assistantPaths';

describe('assistantStackIdentity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-stack-id-')));
    resetAssistantStackIdentityCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    resetAssistantStackIdentityCacheForTests();
  });

  it('is the managed install when no local root is set', () => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    expect(activeAssistantStackIdentity().kind).toBe('managed');
    expect(hermesAgentsStoreName(activeAssistantStackIdentity())).toBe('hermes-agents-managed');
  });

  it('is local for BOUNDARY_ASSISTANT_ROOT, even before the checkout validates', () => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', tmp);
    expect(activeAssistantStackIdentity()).toEqual({ kind: 'local', root: tmp });
  });

  it('treats an override pointing at the managed install as managed', () => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', resolveAssistantProjectRoot());
    expect(activeAssistantStackIdentity().kind).toBe('managed');
  });

  it('follows a root change and names each local stack apart', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', a);
    const nameA = hermesAgentsStoreName(activeAssistantStackIdentity());
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', b);
    const nameB = hermesAgentsStoreName(activeAssistantStackIdentity());
    expect(nameA).toMatch(/^hermes-agents-local-[0-9a-f]{12}$/);
    expect(nameB).not.toBe(nameA);
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', `${a}/`);
    expect(hermesAgentsStoreName(activeAssistantStackIdentity())).toBe(nameA);
  });
});
