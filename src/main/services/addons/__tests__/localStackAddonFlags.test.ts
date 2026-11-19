import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TWENTY_ENTRY } from '../addonCatalog';
import {
  runSyncProfiles,
  writeLocalStackAddonFlags,
  type LocalStackAddonFlagsDeps,
} from '../localStackAddonFlags';
import { fakeSpawn } from '../../__tests__/fakeChild';

const ROOT = '/stack';
const ENV = path.join(ROOT, '.env');
const SYNC = path.join(ROOT, 'scripts', 'sync-profiles.sh');
const ON = { TWENTY_LOCAL_ENABLED: '1', TWENTY_MCP_ENABLED: '1' } as const;
const OFF = { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '0' } as const;

function fakeFs(files: Record<string, string>, sync = { code: 0, output: '' }) {
  const written: Record<string, string> = {};
  const deps: LocalStackAddonFlagsDeps = {
    exists: (p) => p in files,
    readFile: (p) => files[p]!,
    writeFile: (p, contents) => {
      written[p] = contents;
      files[p] = contents;
    },
    syncProfiles: vi.fn(async () => sync),
  };
  return { deps, written };
}

describe('writeLocalStackAddonFlags', () => {
  it('sets both Twenty flags to 1 and runs the profile sync', async () => {
    const { deps, written } = fakeFs({
      [ENV]: 'COMPOSE_PROFILES=core,rag\nTWENTY_MCP_ENABLED=0\nTWENTY_PASSWORD=x\n',
      [SYNC]: '',
    });
    await writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, ON, deps);
    expect(written[ENV]).toBe(
      'COMPOSE_PROFILES=core,rag\nTWENTY_MCP_ENABLED=1\nTWENTY_PASSWORD=x\nTWENTY_LOCAL_ENABLED=1\n'
    );
    expect(deps.syncProfiles).toHaveBeenCalledWith(ROOT);
  });

  it('sets both flags to 0 when the add-on turns off', async () => {
    const { deps, written } = fakeFs({
      [ENV]: 'TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n',
      [SYNC]: '',
    });
    await writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, OFF, deps);
    expect(written[ENV]).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=0\n');
  });

  it('writes each flag its own value, so MCP stays on for hosted workspaces', async () => {
    const { deps, written } = fakeFs({
      [ENV]: 'TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n',
      [SYNC]: '',
    });
    await writeLocalStackAddonFlags(
      ROOT,
      TWENTY_ENTRY,
      { TWENTY_LOCAL_ENABLED: '0', TWENTY_MCP_ENABLED: '1' },
      deps
    );
    expect(written[ENV]).toBe('TWENTY_LOCAL_ENABLED=0\nTWENTY_MCP_ENABLED=1\n');
  });

  it('refuses flags that leave out one of the add-on flags, and writes nothing', async () => {
    const { deps, written } = fakeFs({ [ENV]: '', [SYNC]: '' });
    await expect(
      writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, { TWENTY_LOCAL_ENABLED: '0' }, deps)
    ).rejects.toThrow('No value for TWENTY_MCP_ENABLED.');
    expect(written).toEqual({});
  });

  it('leaves a .env that already matches untouched, and still syncs', async () => {
    const { deps, written } = fakeFs({
      [ENV]: 'TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n',
      [SYNC]: '',
    });
    await writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, ON, deps);
    expect(written).toEqual({});
    expect(deps.syncProfiles).toHaveBeenCalled();
  });

  it('skips the sync on a stack without sync-profiles.sh', async () => {
    const { deps, written } = fakeFs({ [ENV]: '' });
    await writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, ON, deps);
    expect(written[ENV]).toBe('TWENTY_LOCAL_ENABLED=1\nTWENTY_MCP_ENABLED=1\n');
    expect(deps.syncProfiles).not.toHaveBeenCalled();
  });

  it('throws without a .env and writes nothing', async () => {
    const { deps, written } = fakeFs({ [SYNC]: '' });
    await expect(writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, ON, deps)).rejects.toThrow(
      `The stack checkout has no .env at ${ENV}.`
    );
    expect(written).toEqual({});
  });

  it('throws with the end of the output when the sync fails', async () => {
    const { deps } = fakeFs(
      { [ENV]: '', [SYNC]: '' },
      { code: 1, output: "==> Added 'crm'\nerror: rag or neo4j is on but NEO4J_PASSWORD not set in .env.\n" }
    );
    await expect(writeLocalStackAddonFlags(ROOT, TWENTY_ENTRY, ON, deps)).rejects.toThrow(
      "The stack's sync-profiles.sh exited with code 1: ==> Added 'crm' error: rag or neo4j is on but NEO4J_PASSWORD not set in .env.."
    );
  });
});

describe('runSyncProfiles', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs bash scripts/sync-profiles.sh in the stack root and collects its output', async () => {
    const { impl, calls } = fakeSpawn({ stdout: ["==> Added 'crm'\n"], stderr: ['warning: x\n'] });
    const run = runSyncProfiles(ROOT, impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 0, output: "==> Added 'crm'\nwarning: x\n" });
    expect(calls).toEqual([
      {
        command: 'bash',
        args: ['scripts/sync-profiles.sh'],
        options: { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      },
    ]);
  });

  it('resolves with the exit code of a failing script', async () => {
    const run = runSyncProfiles(ROOT, fakeSpawn({ code: 1 }).impl);
    await vi.advanceTimersByTimeAsync(0);
    expect((await run).code).toBe(1);
  });

  it('reports a missing bash as 127', async () => {
    const run = runSyncProfiles(ROOT, fakeSpawn({ fail: true }).impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(await run).toEqual({ code: 127, output: 'spawn bash ENOENT' });
  });

  it('stops a script that runs past the timeout and reports 124', async () => {
    const run = runSyncProfiles(ROOT, fakeSpawn({ hang: true }).impl, 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await run).code).toBe(124);
  });
});
