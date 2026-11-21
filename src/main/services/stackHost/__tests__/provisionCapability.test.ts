import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../shared/stackCapabilities';
import { createFakeStackHost, type FakeStackHost } from '../fakeStackHost';

// Boundary installing, upgrading and backing up its own stack, on a host without provision.

const h = vi.hoisted(() => ({ host: null as unknown as FakeStackHost }));

vi.mock('../capabilities', async () =>
  (await import('../fakeStackHost')).fakeCapabilitiesModule(() => h.host.capabilities)
);

import { ensureSovereignProjectProvisioned } from '../../assistant/provisionSovereignStack';
import { ensureDockerCompatibleCliOnPath, runSovereignSetup } from '../../assistant/runSovereignSetup';
import { recoverInterruptedProjectSwap, swapProjectTreePreservingData } from '../../assistant/projectTreeSwap';
import { backupStackDataBeforeUpgrade } from '../../assistant/stackDataBackup';

const refusal = STACK_CAPABILITY_MISSING_TEXT.provision;

describe('provisioning on a host without provision', () => {
  let dir: string;

  beforeEach(() => {
    h.host = createFakeStackHost({ capabilities: { provision: false } });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-capability-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to download, set up, swap or back up the stack', async () => {
    const fetchImpl = vi.fn();
    await expect(ensureSovereignProjectProvisioned({ fetchImpl })).rejects.toThrow(refusal);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      runSovereignSetup({ projectRoot: dir, workspaceRoot: dir, env: {}, runScript: vi.fn() } as never)
    ).rejects.toThrow(refusal);
    await expect(
      swapProjectTreePreservingData({
        projectRoot: path.join(dir, 'live'),
        nextRoot: path.join(dir, 'next'),
        previousRoot: path.join(dir, 'previous'),
        journalPath: path.join(dir, 'journal.json'),
      } as never)
    ).rejects.toThrow(refusal);
    await expect(recoverInterruptedProjectSwap(path.join(dir, 'journal.json'))).rejects.toThrow(refusal);
    fs.mkdirSync(path.join(dir, 'data', 'hermes'), { recursive: true });
    await expect(
      backupStackDataBeforeUpgrade({ dataRoot: path.join(dir, 'data'), backupsRoot: path.join(dir, 'backups'), name: 'b' })
    ).rejects.toThrow(refusal);
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('writes no docker shim', async () => {
    const env = { PATH: '/usr/bin' };
    await expect(ensureDockerCompatibleCliOnPath(env, path.join(dir, '.boundary-bin'))).resolves.toBe(env);
    expect(fs.existsSync(path.join(dir, '.boundary-bin'))).toBe(false);
  });
});
