import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshConnection } from '../sshConnection';
import {
  createSshStackHost,
  parseStackCredentials,
  parseStackStatus,
  SshStackHostError,
  type SshStackHost,
} from '../sshStackHost';
import { sftpOverLocalFiles, shExec } from './sshTestDoubles';

// `scripts/status.sh --json` as the stack's scripts/lib/stack_status.py prints it at v0.3.16, run
// on a compose config and ps sample: running and stopped services, health only when ps reports
// it, and an empty ports list for a service that publishes none.
const STATUS_SAMPLE =
  '{"version":"v0.3.16","images":{"hermes_agent":"x","hermes_webui":"y"},"project":"sovereign-agent-stack",' +
  '"host":{"os":"linux","arch":"x86_64"},"engine":true,"services":[' +
  '{"name":"detector","state":"stopped","ports":[{"host_ip":"127.0.0.1","host":8790,"container":8001,"protocol":"tcp"}]},' +
  '{"name":"hermes","state":"running","ports":[{"host_ip":"127.0.0.1","host":8642,"container":8642,"protocol":"tcp"},' +
  '{"host_ip":"127.0.0.1","host":8643,"container":8643,"protocol":"tcp"}],"health":"healthy"},' +
  '{"name":"valkey","state":"stopped","ports":[]}]}';

/** A TCP server that answers each line with `<name>:<line>`, standing in for a service on the host. */
function service(name: string): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on('data', (d) => socket.write(`${name}:${d.toString()}`)));
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, server }));
  });
}

function ask(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (d) => (socket.end(), resolve(d.toString())));
    socket.once('error', reject);
  });
}

function statusJson(version: string, services: { name: string; ports: [number, number, string?][] }[]): string {
  return JSON.stringify({
    version,
    images: {},
    project: 'sovereign-agent-stack',
    host: { os: 'linux', arch: 'x86_64' },
    engine: true,
    services: services.map((s) => ({
      name: s.name,
      state: 'running',
      ports: s.ports.map(([host, container, protocol]) => ({ host_ip: '127.0.0.1', host, container, protocol: protocol ?? 'tcp' })),
    })),
  });
}

describe('parseStackStatus and parseStackCredentials', () => {
  it("reads the stack's own status output, with and without the engine", () => {
    const status = parseStackStatus(['some log line', STATUS_SAMPLE]);
    expect(status?.version).toBe('v0.3.16');
    expect(status?.services.map((s) => s.name)).toEqual(['detector', 'hermes', 'valkey']);
    expect(status?.services[1]).toMatchObject({ state: 'running', health: 'healthy' });
    expect(status?.services[0].ports).toEqual([{ host_ip: '127.0.0.1', host: 8790, container: 8001, protocol: 'tcp' }]);
    const down = parseStackStatus([STATUS_SAMPLE.replace('"engine":true', '"engine":false').replaceAll('"running"', '"unknown"')]);
    expect(down?.engine).toBe(false);
  });

  it('refuses output that is not the status shape', () => {
    expect(parseStackStatus(['not json'])).toBeNull();
    expect(parseStackStatus(['{"version":"v0.3.16"}'])).toBeNull();
    expect(parseStackStatus(['{"version":"v0.3.16","services":[{"name":"x","ports":[{"host":"80"}]}]}'])).toBeNull();
  });

  it('reads the four credentials, null when unset, and refuses anything else', () => {
    expect(
      parseStackCredentials([
        '{"HERMES_DASHBOARD_PASSWORD":"pw","HERMES_DASHBOARD_HANDOFF_SECRET":null,"API_SERVER_KEY":"k","LLM_PROXY_ADMIN_TOKEN":"t"}',
      ])
    ).toEqual({ dashboardPassword: 'pw', dashboardHandoffSecret: null, apiServerKey: 'k', llmProxyAdminToken: 't' });
    expect(parseStackCredentials(['{"HERMES_DASHBOARD_PASSWORD":"pw"}'])).toBeNull();
    expect(parseStackCredentials(['{"phase":"error","error":"bad_input"}'])).toBeNull();
  });
});

describe('createSshStackHost', () => {
  let root: string;
  let stack: string;
  let services: net.Server[];
  let forwarded: string[];
  let connection: SshConnection & { close: ReturnType<typeof vi.fn<() => void>>; endConnection(): void };
  let host: SshStackHost | null;

  const writeScript = (name: string, body: string) => fs.writeFileSync(path.join(stack, 'scripts', name), body);
  const setStatus = (json: string) => fs.writeFileSync(path.join(stack, 'status.json'), json);
  const connect = (version = 'v0.3.16') =>
    createSshStackHost({ connection, stackRoot: stack, hostLabel: 'me@pc', version, scriptTimeoutMs: 10_000 }).then(
      (h) => (host = h)
    );

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-stack-host-')));
    stack = path.join(root, 'stack');
    fs.mkdirSync(path.join(stack, 'scripts'), { recursive: true });
    writeScript('status.sh', '[ "$1" = --json ] || exit 2\necho "warming up" >&2\ncat status.json\n');
    services = [];
    forwarded = [];
    host = null;
    let endConnection = () => undefined as void;
    const closed = new Promise<void>((resolve) => (endConnection = resolve));
    connection = {
      exec: shExec().exec,
      sftp: sftpOverLocalFiles(),
      // direct-tcpip as sshd opens it: a TCP connection from the host to host:port there.
      forwardOut: (h, port) =>
        new Promise<Duplex>((resolve, reject) => {
          forwarded.push(`${h}:${port}`);
          const socket = net.connect(port, h, () => resolve(socket));
          socket.once('error', reject);
        }),
      hostKeyFingerprint: 'SHA256:x',
      closed,
      close: vi.fn<() => void>(),
      endConnection: () => endConnection(),
    };
  });

  afterEach(async () => {
    await host?.close();
    await Promise.all(services.map((s) => new Promise((r) => s.close(r))));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const start = async (name: string) => {
    const s = await service(name);
    services.push(s.server);
    return s.port;
  };

  it('forwards each published TCP port and maps stored keys by service and container port', async () => {
    const gateway = await start('gateway');
    const api = await start('api');
    const vikunja = await start('vikunja');
    setStatus(
      statusJson('v0.3.16', [
        { name: 'hermes', ports: [[gateway, 8642], [api, 8643]] },
        { name: 'vikunja-proxy', ports: [[vikunja, 8080]] },
        { name: 'signal-cli', ports: [[39999, 39999, 'udp']] },
      ])
    );
    const h = await connect();
    expect(h.kind).toBe('ssh');
    expect(h.capabilities).toEqual({ hostFolders: false, hostCallbacks: false, provision: false, engineControl: false });
    // One probe connection on connect, to the first published port.
    expect(forwarded).toEqual([`127.0.0.1:${gateway}`]);

    const local = h.endpoints.port('gateway');
    expect(local).not.toBe(gateway);
    expect(await ask(local, 'hi')).toBe('gateway:hi');
    expect(await ask(h.endpoints.port('apiServer'), 'x')).toBe('api:x');
    expect(h.endpoints.url('apiServer', '/health')).toBe(`http://127.0.0.1:${h.endpoints.port('apiServer')}/health`);
    // An add-on's port as the host's .env sets it, not one of the stored keys.
    const addon = h.endpoints.portUrl(vikunja, '/', 'localhost');
    expect(await ask(Number(new URL(addon).port), 'y')).toBe('vikunja:y');
    expect(addon).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(forwarded).toEqual([`127.0.0.1:${gateway}`, `127.0.0.1:${gateway}`, `127.0.0.1:${api}`, `127.0.0.1:${vikunja}`]);
    expect(() => h.endpoints.portUrl(39999)).toThrow(SshStackHostError);
  });

  it('refuses a host whose sshd refuses forwarding, and accepts a published port with nothing listening', async () => {
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [[8642, 8642]] }]));
    // ssh2's channel open failure: `reason` 1 is ADMINISTRATIVELY_PROHIBITED, which OpenSSH sends
    // for `AllowTcpForwarding no`; 2 is CONNECT_FAILED, nothing listening.
    const refuse = (reason: number) => () =>
      Promise.reject(Object.assign(new Error('(SSH) Channel open failure: refused'), { reason }));
    connection.forwardOut = refuse(1);
    await expect(connect()).rejects.toMatchObject({ code: 'forwarding_refused', message: expect.stringMatching(/AllowTcpForwarding/) });
    expect(connection.close).toHaveBeenCalled();
    connection.forwardOut = refuse(2);
    await expect(connect()).resolves.toMatchObject({ kind: 'ssh' });
  });

  it("refuses a key whose service the stack doesn't publish, and a folder on this computer", async () => {
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [] }]));
    const h = await connect();
    expect(() => h.endpoints.port('lightrag')).toThrow(expect.objectContaining({ code: 'port_not_forwarded' }));
    expect(() => h.localPaths).toThrow(expect.objectContaining({ code: 'not_local' }));
  });

  it('refuses a stack that is not the pinned version, naming both, and closes the connection', async () => {
    setStatus(statusJson('v0.3.15', []));
    const error = await connect('v0.3.16').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'version_mismatch', found: 'v0.3.15' });
    expect((error as Error).message).toMatch(/me@pc:.* is v0\.3\.15, but .* needs v0\.3\.16/);
    expect(connection.close).toHaveBeenCalled();
  });

  it("refuses a host whose engine is down before forwarding anything, and keeps the last status on refresh", async () => {
    const down = (json: string) => json.replace('"engine":true', '"engine":false').replaceAll('"running"', '"unknown"');
    setStatus(down(statusJson('v0.3.16', [{ name: 'hermes', ports: [[8642, 8642]] }])));
    await expect(connect()).rejects.toMatchObject({
      code: 'engine_down',
      message: expect.stringMatching(/container engine on me@pc isn't running/),
    });
    expect(forwarded).toEqual([]);
    expect(connection.close).toHaveBeenCalled();

    const gateway = await start('gateway');
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [[gateway, 8642]] }]));
    const h = await connect();
    setStatus(down(statusJson('v0.3.16', [{ name: 'hermes', ports: [[gateway, 8642]] }])));
    await expect(h.refreshEndpoints()).rejects.toMatchObject({ code: 'engine_down' });
    expect(h.status().engine).toBe(true);
  });

  it("connects when the engine answered but the stack couldn't read service states", async () => {
    const gateway = await start('gateway');
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [[gateway, 8642]] }]).replaceAll('"running"', '"unknown"'));
    const h = await connect();
    expect(await ask(h.endpoints.port('gateway'), 'g')).toBe('gateway:g');
  });

  it('names a missing status script and a failing one', async () => {
    fs.rmSync(path.join(stack, 'scripts', 'status.sh'));
    await expect(connect()).rejects.toMatchObject({ code: 'script_missing', message: expect.stringMatching(/scripts\/status\.sh/) });
    expect(connection.close).toHaveBeenCalled();

    writeScript('status.sh', 'echo "error: docker compose config failed" >&2\nexit 1\n');
    await expect(connect()).rejects.toMatchObject({
      code: 'script_failed',
      message: expect.stringMatching(/exited with 1: error: docker compose config failed/),
    });
    writeScript('status.sh', 'echo nothing\n');
    await expect(connect()).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('forwards ports published since connecting and keeps the ones it had', async () => {
    const gateway = await start('gateway');
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [[gateway, 8642]] }]));
    const h = await connect();
    const before = h.endpoints.port('gateway');
    expect(() => h.endpoints.port('detector')).toThrow(SshStackHostError);

    const detector = await start('detector');
    setStatus(
      statusJson('v0.3.16', [
        { name: 'hermes', ports: [[gateway, 8642]] },
        { name: 'detector', ports: [[detector, 8001]] },
      ])
    );
    const status = await h.refreshEndpoints();
    expect(status.services.map((s) => s.name)).toEqual(['hermes', 'detector']);
    expect(h.endpoints.port('gateway')).toBe(before);
    expect(await ask(h.endpoints.port('detector'), 'd')).toBe('detector:d');
  });

  it('reads the credentials through the stack script on each call', async () => {
    setStatus(statusJson('v0.3.16', []));
    const h = await connect();
    await expect(h.credentials()).rejects.toMatchObject({ code: 'script_missing' });
    writeScript(
      'credentials.sh',
      '[ "$1" = --json ] || exit 2\nprintf \'{"HERMES_DASHBOARD_PASSWORD":"pw","HERMES_DASHBOARD_HANDOFF_SECRET":"hs","API_SERVER_KEY":null,"LLM_PROXY_ADMIN_TOKEN":"tok"}\\n\'\n'
    );
    expect(await h.credentials()).toEqual({
      dashboardPassword: 'pw',
      dashboardHandoffSecret: 'hs',
      apiServerKey: null,
      llmProxyAdminToken: 'tok',
    });
    writeScript('credentials.sh', 'echo "error: unknown option" >&2\nexit 2\n');
    await expect(h.credentials()).rejects.toMatchObject({ code: 'script_failed' });
  });

  it("takes the user content folder and profiles from the host's .env", async () => {
    setStatus(statusJson('v0.3.16', []));
    const h = await connect();
    await h.files.writeText('userContent', 'a.txt', 'one');
    expect(fs.readFileSync(path.join(stack, 'data', 'a.txt'), 'utf8')).toBe('one');
    expect(await h.commands.scriptEnv(['crm'])).toEqual({ COMPOSE_PROFILES: 'core,crm' });

    fs.writeFileSync(path.join(stack, '.env'), 'ASSISTANT_DATA_ROOT=../content\nCOMPOSE_PROFILES=core,research\n');
    await h.files.writeText('userContent', 'b.txt', 'two');
    expect(fs.readFileSync(path.join(root, 'content', 'b.txt'), 'utf8')).toBe('two');
    expect(await h.commands.scriptEnv(['crm'])).toEqual({ COMPOSE_PROFILES: 'core,research,crm' });

    fs.writeFileSync(path.join(stack, '.env'), `ASSISTANT_DATA_ROOT=${path.join(root, 'abs')}\n`);
    await h.files.writeText('userContent', 'c.txt', 'three');
    expect(fs.existsSync(path.join(root, 'abs', 'c.txt'))).toBe(true);
  });

  it('ends its forwards and the connection on close, or when the connection drops', async () => {
    const gateway = await start('gateway');
    setStatus(statusJson('v0.3.16', [{ name: 'hermes', ports: [[gateway, 8642]] }]));
    const h = await connect();
    const local = h.endpoints.port('gateway');
    await h.close();
    expect(connection.close).toHaveBeenCalled();
    await expect(ask(local, 'x')).rejects.toThrow(/ECONNREFUSED/);

    connection.close.mockClear();
    const again = await connect();
    const port2 = again.endpoints.port('gateway');
    connection.endConnection();
    await connection.closed;
    // The drop already started the close; this waits for the same one.
    await again.close();
    expect(connection.close).toHaveBeenCalledTimes(1);
    await expect(ask(port2, 'x')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses a stack folder that is not absolute', async () => {
    await expect(createSshStackHost({ connection, stackRoot: 'stack', hostLabel: 'me@pc' })).rejects.toThrow(/absolute/);
  });
});
