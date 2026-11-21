import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshStackHostLocation } from '../../../../shared/types/stackHostLocation';
import type { HostKeyCheck, SshConnection, SshTarget } from '../sshConnection';
import { SshStackHostError, type SshStackHost, type SshStackHostDeps } from '../sshStackHost';
import { connectSshStackLocation, type SshStackSelectionDeps } from '../stackHostSelection';
import { sftpOverLocalFiles } from './sshTestDoubles';

const PIN = 'v0.3.17';
const FINGERPRINT = 'SHA256:abc';

let stackFolder: string;
let tmp: string;

function fakeConnection(): SshConnection & { close: ReturnType<typeof vi.fn<() => void>> } {
  return {
    exec: vi.fn(),
    sftp: sftpOverLocalFiles(),
    forwardOut: vi.fn(),
    hostKeyFingerprint: FINGERPRINT,
    closed: new Promise(() => {}),
    close: vi.fn<() => void>(),
  };
}

const fakeHost = { kind: 'ssh' } as unknown as SshStackHost;

function setup(overrides: Partial<SshStackSelectionDeps> & { offered?: string } = {}) {
  const connection = fakeConnection();
  const targets: SshTarget[] = [];
  const created: SshStackHostDeps[] = [];
  const deps: SshStackSelectionDeps = {
    // Accepts when the check does, as ssh2 does with hostVerifier.
    connect: async (target: SshTarget, check: HostKeyCheck) => {
      targets.push(target);
      if (!(await check(overrides.offered ?? FINGERPRINT))) throw new Error('Host denied (verification failed)');
      return connection;
    },
    readKeyFile: async (file) => fs.readFileSync(file, 'utf8'),
    agentSocket: () => '/tmp/agent.sock',
    createHost: async (hostDeps) => (created.push(hostDeps), fakeHost),
    homeDir: tmp,
    version: PIN,
    ...overrides,
  };
  return { connection, targets, created, deps };
}

const location = (extra: Partial<SshStackHostLocation> = {}): SshStackHostLocation => ({
  kind: 'ssh',
  host: 'pc.example.com',
  user: 'ana',
  key: { kind: 'agent' },
  stackFolder,
  hostKeyFingerprint: FINGERPRINT,
  ...extra,
});

describe('connectSshStackLocation', () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-select-'));
    stackFolder = path.join(tmp, 'stack');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates the host for a release at the pin, signing in with the agent', async () => {
    fs.mkdirSync(stackFolder);
    fs.writeFileSync(path.join(stackFolder, '.stack-version'), `${PIN}\n`);
    const { deps, targets, created, connection } = setup();
    expect(await connectSshStackLocation(location({ port: 2222 }), deps)).toEqual({ ok: true, host: fakeHost });
    expect(targets).toEqual([{ host: 'pc.example.com', port: 2222, username: 'ana', agent: '/tmp/agent.sock' }]);
    expect(created).toEqual([{ connection, stackRoot: stackFolder, hostLabel: 'ana@pc.example.com:2222', version: PIN }]);
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('reads a key file, expanding ~/ to this machine’s home folder', async () => {
    fs.mkdirSync(stackFolder);
    fs.writeFileSync(path.join(stackFolder, '.stack-version'), PIN);
    fs.mkdirSync(path.join(tmp, '.ssh'));
    fs.writeFileSync(path.join(tmp, '.ssh', 'id_test'), 'KEY');
    const { deps, targets } = setup();
    const result = await connectSshStackLocation(location({ key: { kind: 'file', path: '~/.ssh/id_test' } }), deps);
    expect(result.ok).toBe(true);
    expect(targets[0]).toMatchObject({ privateKey: 'KEY' });
    expect(targets[0].agent).toBeUndefined();
  });

  it('reports a key it can’t use before connecting', async () => {
    const noAgent = setup({ agentSocket: () => undefined });
    expect(await connectSshStackLocation(location(), noAgent.deps)).toMatchObject({ ok: false, reason: 'key_unavailable' });
    expect(noAgent.targets).toEqual([]);
    const noFile = setup();
    const result = await connectSshStackLocation(location({ key: { kind: 'file', path: '/nope/id' } }), noFile.deps);
    expect(result).toMatchObject({ ok: false, reason: 'key_unavailable' });
    expect(noFile.targets).toEqual([]);
  });

  it('refuses a host key nobody confirmed, and gives the fingerprint to confirm', async () => {
    const { deps, created } = setup();
    const result = await connectSshStackLocation(location({ hostKeyFingerprint: undefined }), deps);
    expect(result).toMatchObject({ ok: false, reason: 'host_key_unconfirmed', fingerprint: FINGERPRINT });
    expect(created).toEqual([]);
  });

  it('refuses a host key other than the confirmed one', async () => {
    const { deps } = setup({ offered: 'SHA256:other' });
    expect(await connectSshStackLocation(location(), deps)).toMatchObject({
      ok: false,
      reason: 'host_key_changed',
      fingerprint: 'SHA256:other',
    });
  });

  it('reports a failed connection', async () => {
    const { deps } = setup({
      connect: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const result = await connectSshStackLocation(location(), deps);
    expect(result).toMatchObject({ ok: false, reason: 'connect_failed' });
    expect(result.ok === false && result.message).toContain('ECONNREFUSED');
  });

  it('reports a missing stack as needing an install, without installing or creating a host', async () => {
    const { deps, created, connection } = setup();
    expect(await connectSshStackLocation(location(), deps)).toMatchObject({
      ok: false,
      reason: 'needs_install',
      installed: { kind: 'none' },
    });
    expect(created).toEqual([]);
    expect(connection.close).toHaveBeenCalled();
  });

  it('reports a release at another version as needing an upgrade', async () => {
    fs.mkdirSync(stackFolder);
    fs.writeFileSync(path.join(stackFolder, '.stack-version'), 'v0.3.15\n');
    const { deps, created, connection } = setup();
    expect(await connectSshStackLocation(location(), deps)).toMatchObject({
      ok: false,
      reason: 'needs_upgrade',
      found: 'v0.3.15',
    });
    expect(created).toEqual([]);
    expect(connection.close).toHaveBeenCalled();
  });

  it('refuses a folder that holds something else', async () => {
    fs.mkdirSync(stackFolder);
    fs.writeFileSync(path.join(stackFolder, 'notes.txt'), 'x');
    const { deps, connection } = setup();
    expect(await connectSshStackLocation(location(), deps)).toMatchObject({ ok: false, reason: 'not_a_stack' });
    expect(connection.close).toHaveBeenCalled();
  });

  it('lets the status command decide a git checkout’s version', async () => {
    fs.mkdirSync(path.join(stackFolder, '.git'), { recursive: true });
    const { deps } = setup({
      createHost: async () => {
        throw new SshStackHostError('version_mismatch', 'The agent stack is 0.3.16.', 'v0.3.16');
      },
    });
    const result = await connectSshStackLocation(location(), deps);
    expect(result).toMatchObject({ ok: false, reason: 'needs_upgrade', found: 'v0.3.16', installed: { kind: 'checkout' } });
    expect(result.ok === false && result.message).toContain('git');
  });

  it('passes on the stack host’s own refusal', async () => {
    fs.mkdirSync(stackFolder);
    fs.writeFileSync(path.join(stackFolder, '.stack-version'), PIN);
    const { deps } = setup({
      createHost: async () => {
        throw new SshStackHostError('forwarding_refused', 'pc refuses port forwarding');
      },
    });
    expect(await connectSshStackLocation(location(), deps)).toMatchObject({
      ok: false,
      reason: 'host_failed',
      hostError: 'forwarding_refused',
      message: 'pc refuses port forwarding',
    });
  });
});
