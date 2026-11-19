import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureAddonMountSources,
  removeIncompleteHermesProfiles,
  resolveAssistantDataRoot,
  resolveAssistantUserContentRoot,
} from '../assistantPaths';

describe('resolveAssistantUserContentRoot', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpProject(env?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-assistant-data-'));
    temps.push(dir);
    if (env != null) {
      fs.writeFileSync(path.join(dir, '.env'), env, 'utf8');
    }
    return dir;
  }

  it('falls back to {projectRoot}/data when .env is missing', () => {
    const root = tmpProject();
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
    expect(resolveAssistantDataRoot(root)).toBe(path.join(root, 'data'));
  });

  it('treats ./data as the repo data tree', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=./data\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
  });

  it('honors an absolute ASSISTANT_DATA_ROOT', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=/Users/you/AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.resolve('/Users/you/AssistantData')
    );
    expect(resolveAssistantDataRoot(root)).toBe(path.join(root, 'data'));
  });

  it('expands ~/AssistantData', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=~/AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.join(os.homedir(), 'AssistantData')
    );
  });

  it('resolves a relative root against the project checkout', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=../AssistantData\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(
      path.resolve(root, '../AssistantData')
    );
  });

  it('ignores an empty ASSISTANT_DATA_ROOT', () => {
    const root = tmpProject('ASSISTANT_DATA_ROOT=\nFOO=1\n');
    expect(resolveAssistantUserContentRoot(root)).toBe(path.join(root, 'data'));
  });
});

describe('removeIncompleteHermesProfiles', () => {
  const temps: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of temps.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function dataRootWithStubs(): string {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-hermes-profiles-'));
    temps.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server', 'memories'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataRoot, 'hermes', 'profiles', 'browser', 'memories'), {
      recursive: true,
    });
    return dataRoot;
  }

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: rmdir`), { code });
  }

  it('removes stubs and keeps profiles that have config.yaml', async () => {
    const dataRoot = dataRootWithStubs();
    fs.writeFileSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server', 'config.yaml'), '');

    await expect(removeIncompleteHermesProfiles(dataRoot)).resolves.toEqual(['browser']);
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'api-server'))).toBe(true);
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'browser'))).toBe(false);
  });

  it('retries a stub whose delete is briefly refused', async () => {
    const dataRoot = dataRootWithStubs();
    const realRm = fs.promises.rm.bind(fs.promises);
    let refusals = 2;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).endsWith('browser') && refusals-- > 0) throw errno('EACCES');
      return realRm(target, opts);
    });

    await expect(removeIncompleteHermesProfiles(dataRoot, { retryDelayMs: 0 })).resolves.toEqual([
      'api-server',
      'browser',
    ]);
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'browser'))).toBe(false);
  });

  it('leaves a stub in place instead of throwing when it stays undeletable', async () => {
    const dataRoot = dataRootWithStubs();
    const realRm = fs.promises.rm.bind(fs.promises);
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, opts) => {
      if (String(target).endsWith('browser')) throw errno('EACCES');
      return realRm(target, opts);
    });

    await expect(removeIncompleteHermesProfiles(dataRoot, { retryDelayMs: 0 })).resolves.toEqual([
      'api-server',
    ]);
    expect(rm.mock.calls.filter(([target]) => String(target).endsWith('browser'))).toHaveLength(5);
    expect(fs.existsSync(path.join(dataRoot, 'hermes', 'profiles', 'browser'))).toBe(true);
  });

  it('does not retry errors that are not transient', async () => {
    const dataRoot = dataRootWithStubs();
    const rm = vi.spyOn(fs.promises, 'rm').mockRejectedValue(errno('EROFS'));

    await expect(removeIncompleteHermesProfiles(dataRoot, { retryDelayMs: 0 })).resolves.toEqual([]);
    expect(rm).toHaveBeenCalledTimes(2);
  });
});

describe('ensureAddonMountSources', () => {
  it('creates the add-on folders the core bootstraps mount, owner-only, and keeps what is there', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-mounts-'));
    try {
      fs.mkdirSync(path.join(root, 'addons', 'twenty', 'instances'), { recursive: true });
      fs.writeFileSync(path.join(root, 'addons', 'twenty', 'instances', 'main.json'), '{}');
      await ensureAddonMountSources(root);
      for (const sub of [
        'addons/twenty/secrets',
        'addons/actual/instances',
        'addons/actual/secrets',
        'addons/email/config',
        'addons/email/instances',
        'addons/email/secrets',
        // Stack v0.3.15 mounts addons/caldav on both bootstraps.
        'addons/caldav',
        'addons/caldav/instances',
        'addons/caldav/secrets',
      ]) {
        expect(fs.statSync(path.join(root, sub)).mode & 0o777).toBe(0o700);
      }
      expect(fs.readFileSync(path.join(root, 'addons', 'twenty', 'instances', 'main.json'), 'utf8')).toBe('{}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ensureAddonMountSources creates the email folders at 0700', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-mounts-email-'));
    try {
      await ensureAddonMountSources(root);
      for (const sub of ['config', 'instances', 'secrets']) {
        expect(fs.statSync(path.join(root, 'addons', 'email', sub)).mode & 0o777).toBe(0o700);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
