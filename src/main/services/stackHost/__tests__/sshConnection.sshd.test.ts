/**
 * The SSH stack host against a real OpenSSH server (remote stack plan, phase 4): a throwaway
 * `sshd` on 127.0.0.1 run as this user, with its own host key, client key and config in a temp
 * folder, and the stack folder in that temp folder too. Runs only with BOUNDARY_SSHD_TEST=1 and
 * an `sshd` and `sftp-server` on this machine (macOS ships both).
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectEnvVia } from '../../assistant/projectEnv';
import { connectSsh, type SshConnection } from '../sshConnection';
import { sshStackCommands } from '../sshStackCommands';
import { sftpStackFiles } from '../sshStackFiles';
import { createSshStackHost } from '../sshStackHost';
import { installStackOverSsh, readInstalledStack } from '../sshStackInstall';
import { verifyStackRelease } from '../stackRelease';
import { connectSshStackLocation } from '../stackHostSelection';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../../shared/assistantStackConstants';
import type { SshStackHostLocation } from '../../../../shared/types/stackHostLocation';

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p));
const SFTP_SERVER = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server'].find((p) =>
  fs.existsSync(p)
);
const enabled = process.env.BOUNDARY_SSHD_TEST === '1' && !!SSHD && !!SFTP_SERVER;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => (socket.end(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`sshd didn't listen on ${port}`);
}

/** Starts an sshd on a free port with its config in `dir/<name>_config`, using `dir`'s keys. */
async function startSshd(dir: string, name: string, extra: string[] = []): Promise<{ port: number; sshd: ChildProcess }> {
  const port = await freePort();
  const config = path.join(dir, `${name}_config`);
  fs.writeFileSync(
    config,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${path.join(dir, 'hostkey')}`,
      `PidFile ${path.join(dir, `${name}.pid`)}`,
      `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      `Subsystem sftp ${SFTP_SERVER}`,
      ...extra,
      '',
    ].join('\n')
  );
  // -D keeps it in the foreground, so it is this test's child and stops with it.
  const sshd = spawn(SSHD!, ['-D', '-e', '-f', config], { stdio: 'ignore' });
  await waitForPort(port);
  return { port, sshd };
}

describe.skipIf(!enabled)('SSH stack host against a real sshd', () => {
  let dir: string;
  let port: number;
  let sshd: ChildProcess;
  let hostFingerprint: string;
  let connection: SshConnection;
  const stackRoot = () => path.join(dir, 'stack');
  const connectToSshd = (to = port) =>
    connectSsh(
      { host: '127.0.0.1', port: to, username: os.userInfo().username, privateKey: fs.readFileSync(path.join(dir, 'client'), 'utf8') },
      (fingerprint) => fingerprint === hostFingerprint
    );

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-sshd-')));
    for (const name of ['hostkey', 'client']) {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(dir, name)]);
    }
    fs.copyFileSync(path.join(dir, 'client.pub'), path.join(dir, 'authorized_keys'));
    hostFingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', path.join(dir, 'hostkey.pub')], {
      encoding: 'utf8',
    }).split(' ')[1];
    ({ port, sshd } = await startSshd(dir, 'sshd'));

    fs.mkdirSync(path.join(stackRoot(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(stackRoot(), '.env'), 'COMPOSE_PROFILES=core,research\nLLM_MODEL=old\n');
    connection = await connectToSshd();
  }, 30_000);

  afterAll(() => {
    connection?.close();
    sshd?.kill('SIGTERM');
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pins the host key by its SHA-256 fingerprint, as ssh-keygen prints it', async () => {
    expect(connection.hostKeyFingerprint).toBe(hostFingerprint);
    await expect(
      connectSsh(
        { host: '127.0.0.1', port, username: os.userInfo().username, privateKey: fs.readFileSync(path.join(dir, 'client'), 'utf8') },
        () => false
      )
    ).rejects.toThrow();
  });

  it('reads, writes, lists and removes stack files over SFTP', async () => {
    const files = sftpStackFiles(connection.sftp, { stackRoot: stackRoot(), userContentRoot: async () => path.join(dir, 'content') });
    expect(await files.readText('stack', 'missing')).toBeNull();
    await files.writeText('data', 'hermes/profiles/a/.env', 'K=1\n', { mode: 0o600 });
    expect(fs.statSync(path.join(stackRoot(), 'data/hermes/profiles/a/.env')).mode & 0o777).toBe(0o600);
    await files.writeText('data', 'hermes/profiles/a/.env', 'K=2\n');
    expect(await files.readText('data', 'hermes/profiles/a/.env')).toBe('K=2\n');
    expect(fs.statSync(path.join(stackRoot(), 'data/hermes/profiles/a/.env')).mode & 0o777).toBe(0o600);
    expect(await files.list('data', 'hermes/profiles/a')).toEqual(['.env']);
    expect(await files.stat('data', 'hermes')).toEqual({ kind: 'folder', size: 0 });
    expect(await files.realpath('data', 'hermes/profiles')).toBe('hermes/profiles');
    await files.remove('data', 'hermes');
    expect(fs.existsSync(path.join(stackRoot(), 'data/hermes'))).toBe(false);
  });

  it('runs a stack script in the stack folder with its arguments, variables and stdin', async () => {
    fs.writeFileSync(
      path.join(stackRoot(), 'scripts', 'echo.sh'),
      'printf "%s|" "$PWD" "$@" "$STACK_CLIENT" "$COMPOSE_PROFILES"; IFS= read -r l; printf "%s\\n" "$l"; exit 3\n'
    );
    const commands = sshStackCommands({ exec: connection.exec, stackRoot: stackRoot(), envProfiles: async () => 'core,research' });
    const out: string[] = [];
    const code = await commands.runScript('scripts/echo.sh', ["a b'c", '$HOME'], {
      env: { ...(await commands.scriptEnv(['crm'])), STACK_CLIENT: 'boundary' },
      input: '{"k":1}',
      timeoutMs: 10_000,
      timeoutLine: '',
      onStdout: (line) => out.push(line),
      onStderr: () => undefined,
    });
    expect(code).toBe(3);
    expect(out).toEqual([`${stackRoot()}|a b'c|$HOME|boundary|core,research,crm|{"k":1}`]);
  });

  it('stops a script past its time limit', async () => {
    fs.writeFileSync(path.join(stackRoot(), 'scripts', 'sleep.sh'), 'sleep 30\n');
    const commands = sshStackCommands({ exec: connection.exec, stackRoot: stackRoot(), envProfiles: async () => null });
    const started = Date.now();
    const code = await commands.runScript('scripts/sleep.sh', [], {
      env: {},
      timeoutMs: 300,
      timeoutLine: 'too slow',
      onStdout: () => undefined,
      onStderr: () => undefined,
    });
    expect(code).toBe(124);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('changes the project .env through env.sh over SSH when the stack has it', async () => {
    const stackScripts = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || path.resolve(__dirname, '../../../../../../assistant');
    if (!fs.existsSync(path.join(stackScripts, 'scripts', 'env.sh'))) return;
    fs.cpSync(path.join(stackScripts, 'scripts'), path.join(stackRoot(), 'scripts'), { recursive: true });
    const files = sftpStackFiles(connection.sftp, { stackRoot: stackRoot(), userContentRoot: async () => path.join(stackRoot(), 'data') });
    const commands = sshStackCommands({ exec: connection.exec, stackRoot: stackRoot(), envProfiles: async () => null });
    const env = projectEnvVia(commands, files);
    expect(await env.set({ LLM_MODEL: 'new' })).toBe(true);
    expect(fs.readFileSync(path.join(stackRoot(), '.env'), 'utf8')).toContain('LLM_MODEL=new\n');
  });

  it('reads status and credentials through stand-in scripts and forwards a published port', async () => {
    // A service listening on the host's loopback, as the stack publishes on 127.0.0.1.
    const echo = net.createServer((socket) => socket.on('data', (d) => socket.write(`hermes:${d.toString()}`)));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const servicePort = (echo.address() as net.AddressInfo).port;
    // The shapes stack_status.py and credentials.sh print at v0.3.16.
    const status = {
      version: 'v0.3.16',
      images: {},
      project: 'sovereign-agent-stack',
      host: { os: 'darwin', arch: 'arm64' },
      engine: true,
      services: [
        { name: 'hermes', state: 'running', ports: [{ host_ip: '127.0.0.1', host: servicePort, container: 8642, protocol: 'tcp' }] },
      ],
    };
    fs.writeFileSync(path.join(stackRoot(), 'scripts', 'status.sh'), `[ "$1" = --json ] || exit 2\necho '${JSON.stringify(status)}'\n`);
    fs.writeFileSync(
      path.join(stackRoot(), 'scripts', 'credentials.sh'),
      `[ "$1" = --json ] || exit 2\necho '{"HERMES_DASHBOARD_PASSWORD":"pw","HERMES_DASHBOARD_HANDOFF_SECRET":null,"API_SERVER_KEY":"key","LLM_PROXY_ADMIN_TOKEN":"tok"}'\n`
    );
    const host = await createSshStackHost({ connection: await connectToSshd(), stackRoot: stackRoot(), hostLabel: 'sshd-test' });
    try {
      expect(host.status().services[0].name).toBe('hermes');
      const local = host.endpoints.port('gateway');
      expect(local).not.toBe(servicePort);
      const answer = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(local, '127.0.0.1', () => socket.write('ping'));
        socket.once('data', (d) => (socket.end(), resolve(d.toString())));
        socket.once('error', reject);
      });
      expect(answer).toBe('hermes:ping');
      expect(await host.credentials()).toEqual({
        dashboardPassword: 'pw',
        dashboardHandoffSecret: null,
        apiServerKey: 'key',
        llmProxyAdminToken: 'tok',
      });
    } finally {
      await host.close();
      await new Promise((resolve) => echo.close(resolve));
    }
  });

  it('installs a release through a stand-in install.sh, which checks the uploaded checksum', async () => {
    // Takes install.sh's arguments at v0.3.16 and prints its JSON lines; unpacks the release
    // where a real install would, and records what it was asked to skip and pass to setup.
    const standIn = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SKIP="" SETUP=""',
      'while [[ $# -gt 0 ]]; do case "$1" in',
      '  --version) V=$2; shift 2 ;; --dir) D=$2; shift 2 ;; --tarball) T=$2; shift 2 ;; --sha256) S=$2; shift 2 ;;',
      '  --skip-volume) SKIP=$2; shift 2 ;; --json) shift ;; --) shift; SETUP="$*"; break ;; *) exit 2 ;;',
      'esac; done',
      'echo \'{"phase":"setup","step":"check","status":"done"}\'',
      'got="$( (sha256sum "$T" 2> /dev/null || shasum -a 256 "$T") | cut -d" " -f1)"',
      'if [[ "$got" != "$S" ]]; then',
      '  echo "{\\"phase\\":\\"error\\",\\"error\\":\\"checksum_mismatch\\",\\"step\\":\\"verify\\",\\"message\\":\\"sha256 $got, expected $S\\",\\"logTail\\":[],\\"rolledBack\\":false,\\"backup\\":null}"',
      '  exit 1',
      'fi',
      'echo \'{"phase":"setup","step":"verify","status":"done"}\'',
      'mkdir -p "$D" && tar -xzf "$T" -C "$D" --strip-components 1',
      'printf "%s|%s\\n" "$SKIP" "$SETUP" > "$D/args.txt"',
      'echo "{\\"phase\\":\\"done\\",\\"version\\":\\"$V\\",\\"previous_version\\":null,\\"fresh\\":true,\\"backup\\":null,\\"needs_user\\":[{\\"id\\":\\"bitwarden-in-page-fill\\",\\"message\\":\\"Sign in again.\\",\\"version\\":\\"$V\\"}],\\"notices\\":[],\\"doctor\\":\\"passed\\"}"',
      '',
    ].join('\n');
    const top = path.join(dir, 'release', 'sovereign-agent-stack-v9.9.9');
    fs.mkdirSync(path.join(top, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(top, '.stack-version'), 'v9.9.9\n');
    fs.writeFileSync(path.join(top, '.stack-files'), 'scripts/install.sh\n');
    fs.writeFileSync(path.join(top, 'scripts', 'install.sh'), standIn);
    const tarPath = path.join(dir, 'release', 'release.tar.gz');
    execFileSync('tar', ['-czf', tarPath, '-C', path.dirname(top), path.basename(top)]);
    const tarball = fs.readFileSync(tarPath);
    const release = verifyStackRelease(tarball, 'v9.9.9', createHash('sha256').update(tarball).digest('hex'));
    const target = path.join(dir, 'installed');
    const steps: string[] = [];

    const result = await installStackOverSsh({
      connection,
      stackRoot: target,
      hostLabel: 'sshd-test',
      release,
      leaveOutModels: true,
      setupArgs: ['--db'],
      onStep: (s) => steps.push(s.step),
      pollMs: 100,
    });
    expect(result).toMatchObject({ version: 'v9.9.9', fresh: true, needsUser: [{ id: 'bitwarden-in-page-fill' }] });
    expect(steps).toEqual(['check', 'verify']);
    expect(await readInstalledStack(connection.sftp, target)).toEqual({ kind: 'release', version: 'v9.9.9' });
    expect(fs.readFileSync(path.join(target, 'args.txt'), 'utf8')).toBe('ollama_data|--db\n');

    await expect(
      installStackOverSsh({ connection, stackRoot: target, hostLabel: 'sshd-test', release: { ...release, sha256: '0'.repeat(64) }, pollMs: 100 })
    ).rejects.toMatchObject({ code: 'checksum_mismatch', step: 'verify' });
  }, 30_000);

  it('refuses a host whose sshd has AllowTcpForwarding no', async () => {
    const other = await startSshd(dir, 'nofwd', ['AllowTcpForwarding no']);
    try {
      const status = { version: 'v0.3.16', project: 'p', engine: true, services: [{ name: 'hermes', state: 'running', ports: [{ host_ip: '127.0.0.1', host: other.port, container: 8642, protocol: 'tcp' }] }] };
      fs.writeFileSync(path.join(stackRoot(), 'scripts', 'status.sh'), `echo '${JSON.stringify(status)}'\n`);
      await expect(
        createSshStackHost({ connection: await connectToSshd(other.port), stackRoot: stackRoot(), hostLabel: 'sshd-test' })
      ).rejects.toMatchObject({ code: 'forwarding_refused' });
    } finally {
      other.sshd.kill('SIGTERM');
    }
  });

  it("refuses a stack folder without the stack's status script", async () => {
    fs.rmSync(path.join(stackRoot(), 'scripts', 'status.sh'), { force: true });
    await expect(
      createSshStackHost({ connection: await connectToSshd(), stackRoot: stackRoot(), hostLabel: 'sshd-test' })
    ).rejects.toMatchObject({ code: 'script_missing' });
  });

  it('opens a stored location only at a confirmed host key and the pinned version', async () => {
    const folder = path.join(dir, 'selected-stack');
    const location: SshStackHostLocation = {
      kind: 'ssh',
      host: '127.0.0.1',
      port,
      user: os.userInfo().username,
      key: { kind: 'file', path: path.join(dir, 'client') },
      stackFolder: folder,
    };
    const deps = {
      connect: connectSsh,
      readKeyFile: (file: string) => fs.promises.readFile(file, 'utf8'),
      agentSocket: (): string | undefined => undefined,
      createHost: createSshStackHost,
      homeDir: os.homedir(),
      version: SOVEREIGN_AGENT_STACK_VERSION,
    };
    // Nothing confirmed yet: the fingerprint offered is the one ssh-keygen prints.
    expect(await connectSshStackLocation(location, deps)).toMatchObject({
      ok: false,
      reason: 'host_key_unconfirmed',
      fingerprint: hostFingerprint,
    });
    const confirmed = { ...location, hostKeyFingerprint: hostFingerprint };
    expect(await connectSshStackLocation({ ...location, hostKeyFingerprint: 'SHA256:other' }, deps)).toMatchObject({
      ok: false,
      reason: 'host_key_changed',
    });
    expect(await connectSshStackLocation(confirmed, deps)).toMatchObject({ ok: false, reason: 'needs_install' });
    fs.mkdirSync(path.join(folder, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(folder, '.stack-version'), 'v0.3.1\n');
    expect(await connectSshStackLocation(confirmed, deps)).toMatchObject({
      ok: false,
      reason: 'needs_upgrade',
      found: 'v0.3.1',
    });
    fs.writeFileSync(path.join(folder, '.stack-version'), `${SOVEREIGN_AGENT_STACK_VERSION}\n`);
    const status = { version: SOVEREIGN_AGENT_STACK_VERSION, project: 'p', engine: true, services: [] as unknown[] };
    fs.writeFileSync(path.join(folder, 'scripts', 'status.sh'), `echo '${JSON.stringify(status)}'\n`);
    const selected = await connectSshStackLocation(confirmed, deps);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    try {
      expect(selected.host.capabilities).toEqual({ hostFolders: false, hostCallbacks: false, provision: false, engineControl: false });
      expect(await selected.host.files.readText('stack', '.stack-version')).toBe(`${SOVEREIGN_AGENT_STACK_VERSION}\n`);
      expect(() => selected.host.localPaths).toThrow('no folder on this computer');
    } finally {
      await selected.host.close();
    }
  });
});
