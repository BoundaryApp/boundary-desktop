import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE,
  SOVEREIGN_AGENT_STACK_GITHUB_URL,
} from '../../../../shared/assistantStackConstants';

describe('resolveAssistantRoot', () => {
  const prevEnv = process.env.BOUNDARY_ASSISTANT_ROOT;
  let tmpRoot: string | null = null;

  afterEach(async () => {
    (await import('../resolveAssistantRoot')).forgetAssistantRootChecks();
    if (prevEnv === undefined) {
      delete process.env.BOUNDARY_ASSISTANT_ROOT;
    } else {
      process.env.BOUNDARY_ASSISTANT_ROOT = prevEnv;
    }
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  it('prefers BOUNDARY_ASSISTANT_ROOT when compose file exists', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-root-'));
    fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveAssistantRoot } = await import('../resolveAssistantRoot');
    expect(resolveAssistantRoot()).toBe(path.resolve(tmpRoot));
  });

  it('throws when BOUNDARY_ASSISTANT_ROOT is missing compose file', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-root-bad-'));
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
    expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
  });

  it('uses userData project when present and does not require sibling assistant', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    const projectRoot = resolveAssistantProjectRoot();
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    tmpRoot = projectRoot;

    const { resolveAssistantRoot } = await import('../resolveAssistantRoot');
    expect(resolveAssistantRoot()).toBe(path.resolve(projectRoot));
  });

  it('error message cites GitHub repo when project missing', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    const projectRoot = resolveAssistantProjectRoot();
    fs.rmSync(projectRoot, { recursive: true, force: true });

    const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
    expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
    try {
      resolveAssistantRoot();
    } catch (error) {
      expect(String(error)).toContain(SOVEREIGN_AGENT_STACK_GITHUB_URL);
      expect(String(error)).not.toContain('../assistant');
    }
  });

  it('puts Hermes data under a local stack, not the userData install', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-active-'));
    fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
    process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;

    const { resolveActiveAssistantDataRoot } = await import('../resolveAssistantRoot');
    expect(resolveActiveAssistantDataRoot()).toBe(path.join(path.resolve(tmpRoot), 'data'));
  });

  it('falls back to the userData install when no stack resolves', async () => {
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    const { resolveAssistantProjectRoot } = await import('../assistantPaths');
    fs.rmSync(resolveAssistantProjectRoot(), { recursive: true, force: true });

    const { resolveActiveAssistantDataRoot } = await import('../resolveAssistantRoot');
    expect(resolveActiveAssistantDataRoot()).toBe(path.join(resolveAssistantProjectRoot(), 'data'));
  });

  describe('cached compose-file checks', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function stackDir(): string {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-cache-'));
      fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
      process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;
      return tmpRoot;
    }

    it('checks the disk once, then answers from memory without a blocking call', async () => {
      stackDir();
      const { resolveAssistantRoot } = await import('../resolveAssistantRoot');
      const existsSync = vi.spyOn(fs, 'existsSync');
      resolveAssistantRoot();
      resolveAssistantRoot();
      resolveAssistantRoot();
      expect(existsSync).toHaveBeenCalledTimes(1);
    });

    it('rechecks an old find in the background and fails once the file is gone', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const dir = stackDir();
      const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
      resolveAssistantRoot();
      fs.rmSync(path.join(dir, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE));

      // Within five seconds the cached find still answers.
      expect(resolveAssistantRoot()).toBe(path.resolve(dir));
      vi.setSystemTime(Date.now() + 5_000);
      // Past them it still answers once, and starts a recheck that drops the find.
      let finishRecheck!: (error: Error) => void;
      const access = vi
        .spyOn(fs.promises, 'access')
        .mockReturnValueOnce(new Promise((_resolve, reject) => (finishRecheck = reject)));
      expect(resolveAssistantRoot()).toBe(path.resolve(dir));
      expect(access).toHaveBeenCalledTimes(1);
      // A second call while the recheck runs doesn't start another.
      expect(resolveAssistantRoot()).toBe(path.resolve(dir));
      expect(access).toHaveBeenCalledTimes(1);
      finishRecheck(new Error('ENOENT'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
    });

    it('sees a stack installed after a miss on the next call', async () => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-late-'));
      process.env.BOUNDARY_ASSISTANT_ROOT = tmpRoot;
      const { resolveAssistantRoot, AssistantRootError } = await import('../resolveAssistantRoot');
      expect(() => resolveAssistantRoot()).toThrow(AssistantRootError);
      fs.writeFileSync(path.join(tmpRoot, BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE), 'services: {}\n');
      expect(resolveAssistantRoot()).toBe(path.resolve(tmpRoot));
    });
  });
});
