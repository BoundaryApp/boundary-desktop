import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeAssistantStackIdentity,
  claimLegacyHermesAgentsStore,
  hermesAgentsStoreName,
  resetAssistantStackIdentityCacheForTests,
} from '../assistantStackIdentity';
import { resolveAssistantProjectRoot } from '../assistantPaths';

describe('assistantStackIdentity', () => {
  const prevRoot = process.env.BOUNDARY_ASSISTANT_ROOT;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-stack-id-')));
    resetAssistantStackIdentityCacheForTests();
  });

  afterEach(() => {
    if (prevRoot === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevRoot;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    resetAssistantStackIdentityCacheForTests();
  });

  it('is the managed install when no local root is set', () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    expect(activeAssistantStackIdentity().kind).toBe('managed');
    expect(hermesAgentsStoreName(activeAssistantStackIdentity())).toBe('hermes-agents-managed');
  });

  it('is local for BOUNDARY_ASSISTANT_ROOT, even before the checkout validates', () => {
    process.env.BOUNDARY_ASSISTANT_ROOT = tmp;
    expect(activeAssistantStackIdentity()).toEqual({ kind: 'local', root: tmp });
  });

  it('treats an override pointing at the managed install as managed', () => {
    process.env.BOUNDARY_ASSISTANT_ROOT = resolveAssistantProjectRoot();
    expect(activeAssistantStackIdentity().kind).toBe('managed');
  });

  it('follows a root change and names each local stack apart', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    process.env.BOUNDARY_ASSISTANT_ROOT = a;
    const nameA = hermesAgentsStoreName(activeAssistantStackIdentity());
    process.env.BOUNDARY_ASSISTANT_ROOT = b;
    const nameB = hermesAgentsStoreName(activeAssistantStackIdentity());
    expect(nameA).toMatch(/^hermes-agents-local-[0-9a-f]{12}$/);
    expect(nameB).not.toBe(nameA);
    process.env.BOUNDARY_ASSISTANT_ROOT = `${a}/`;
    expect(hermesAgentsStoreName(activeAssistantStackIdentity())).toBe(nameA);
  });

  describe('claimLegacyHermesAgentsStore', () => {
    const local = () => ({ kind: 'local' as const, root: '/dev/assistant' });

    it('moves the pre-split store to the local stack and keeps a backup', () => {
      fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{"agents":[1]}');
      expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(true);
      const target = path.join(tmp, `${hermesAgentsStoreName(local())}.json`);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"agents":[1]}');
      expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(false);
      expect(fs.readFileSync(path.join(tmp, 'hermes-agents.pre-split.json'), 'utf8')).toBe(
        '{"agents":[1]}'
      );
    });

    it('never overwrites a stack store that already exists', () => {
      fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{"old":true}');
      const target = path.join(tmp, `${hermesAgentsStoreName(local())}.json`);
      fs.writeFileSync(target, '{"current":true}');
      expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"current":true}');
      expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(true);
    });

    it('leaves the pre-split store alone for the managed stack', () => {
      fs.writeFileSync(path.join(tmp, 'hermes-agents.json'), '{}');
      const managed = { kind: 'managed' as const, root: '/userData/project' };
      expect(claimLegacyHermesAgentsStore(managed, tmp)).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'hermes-agents.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'hermes-agents-managed.json'))).toBe(false);
    });

    it('does nothing without a pre-split store', () => {
      expect(claimLegacyHermesAgentsStore(local(), tmp)).toBe(false);
    });
  });
});
