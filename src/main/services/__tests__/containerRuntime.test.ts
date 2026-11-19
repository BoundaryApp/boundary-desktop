import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContainerRuntimeUnavailableError,
  composeArgv,
  getContainerRuntime,
  getLastSystemDockerProbe,
  resetContainerRuntimeCache,
  resolveContainerRuntime,
  runCli,
  runCompose,
  runComposeStreaming,
  stopBundledMachineIfStarted,
  BOUNDARY_MACHINE_NAME,
} from '../containerRuntime';
import {
  defaultDockerApiEndpoint,
  dockerodeOptionsFromApiEndpoint,
} from '../containerRuntime/apiEndpoint';
import { fakeChild } from './fakeChild';

describe('dockerodeOptionsFromApiEndpoint', () => {
  it('parses unix sockets', () => {
    expect(dockerodeOptionsFromApiEndpoint('unix:///var/run/docker.sock')).toEqual({
      socketPath: '/var/run/docker.sock',
    });
  });

  it('parses named pipes', () => {
    expect(dockerodeOptionsFromApiEndpoint('npipe:////./pipe/docker_engine')).toEqual({
      socketPath: '//./pipe/docker_engine',
    });
  });

  it('parses tcp endpoints', () => {
    expect(dockerodeOptionsFromApiEndpoint('tcp://127.0.0.1:2375')).toEqual({
      protocol: 'http',
      host: '127.0.0.1',
      port: 2375,
    });
  });
});

describe('defaultDockerApiEndpoint', () => {
  it('prefers DOCKER_HOST', () => {
    expect(defaultDockerApiEndpoint('darwin', { DOCKER_HOST: 'unix:///tmp/custom.sock' })).toBe(
      'unix:///tmp/custom.sock'
    );
  });

  it('uses npipe on Windows', () => {
    expect(defaultDockerApiEndpoint('win32', {})).toBe('npipe:////./pipe/docker_engine');
  });

  it('uses unix socket on darwin/linux', () => {
    expect(defaultDockerApiEndpoint('darwin', {})).toBe('unix:///var/run/docker.sock');
    expect(defaultDockerApiEndpoint('linux', {})).toBe('unix:///var/run/docker.sock');
  });
});

/** System Docker discovery stubs: every endpoint answers, the CLI is at /fake/bin/docker. */
function systemDockerDeps(
  overrides: { reachable?: (endpoint: string) => boolean; cli?: string | null } = {}
) {
  const reachable = overrides.reachable ?? (() => true);
  return {
    homeDir: '/Users/test',
    pingDocker: vi.fn(async (endpoint: string) => {
      if (!reachable(endpoint)) throw new Error('socket not found');
    }),
    readLoginShellPath: async (): Promise<string | null> => null,
    findDockerCli: () => (overrides.cli === undefined ? '/fake/bin/docker' : overrides.cli),
  };
}

describe('resolveContainerRuntime', () => {
  afterEach(() => {
    resetContainerRuntimeCache();
  });

  it('returns a system docker runtime when CLI and daemon respond', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'version') {
        return { stdout: '27.0.0\n', stderr: '' };
      }
      if (args[0] === 'info') {
        return { stdout: '27.0.0\n', stderr: '' };
      }
      if (args[0] === 'compose') {
        return { stdout: '2.29.0\n', stderr: '' };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const runtime = await resolveContainerRuntime({
      execFile: execFile as never,
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      ...systemDockerDeps({
        reachable: (endpoint) => endpoint === 'unix:///Users/test/.orbstack/run/docker.sock',
      }),
    });

    expect(runtime.kind).toBe('docker');
    expect(runtime.origin).toBe('system');
    expect(runtime.cliPath).toBe('/fake/bin/docker');
    expect(execFile).toHaveBeenCalledWith('/fake/bin/docker', expect.anything(), expect.anything());
    expect(runtime.composeArgv).toEqual(['compose']);
    expect(runtime.apiEndpoint).toBe('unix:///Users/test/.orbstack/run/docker.sock');
    expect(runtime.env.DOCKER_HOST).toBe('unix:///Users/test/.orbstack/run/docker.sock');
    expect(runtime.env.PATH?.split(':')[0]).toBe('/fake/bin');
    expect(runtime.version.cli).toBe('27.0.0');
    expect(runtime.version.compose).toBe('2.29.0');
  });

  it('falls back to bundled Podman when Docker is unavailable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-bundled-'));
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(root, 'share', 'krunkit'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'podman'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'bin', 'docker-compose'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'bin', 'gvproxy'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'bin', 'krunkit'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'lib', 'libkrun.dylib'), 'dylib');
    fs.writeFileSync(path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd'), 'fw');
    const stateDir = path.join(root, 'state');
    const binDir = path.join(root, 'bin');
    const paths = {
      root,
      binDir,
      helperDir: binDir,
      libDir: path.join(root, 'lib'),
      firmwarePath: path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd'),
      podmanPath: path.join(root, 'bin', 'podman'),
      composePath: path.join(root, 'bin', 'docker-compose'),
      machineImagePath: null as string | null,
      stateDir,
      containersConfPath: path.join(stateDir, 'containers.conf'),
    };

    const execFile = vi.fn(async (bin: string, args: string[]) => {
      if (bin === paths.podmanPath && args[0] === 'version') {
        return { stdout: '6.0.1\n', stderr: '' };
      }
      if (bin === paths.composePath && args[0] === 'version') {
        return { stdout: '2.38.2\n', stderr: '' };
      }
      throw new Error(`unexpected ${bin} ${args.join(' ')}`);
    });

    try {
      const runtime = await resolveContainerRuntime({
        execFile: execFile as never,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        ...systemDockerDeps({ cli: null }),
        resolveBundledPaths: () => paths,
        ensureBundledMachine: async () => ({
          apiEndpoint: 'unix:///tmp/boundary.sock',
          dockerHost: 'unix:///tmp/boundary.sock',
        }),
      });

      expect(runtime.kind).toBe('podman');
      expect(runtime.origin).toBe('bundled');
      expect(runtime.cliPath).toBe(paths.podmanPath);
      expect(runtime.composeBinaryPath).toBe(paths.composePath);
      expect(runtime.composeArgv).toEqual([]);
      expect(runtime.apiEndpoint).toBe('unix:///tmp/boundary.sock');
      expect(runtime.version.compose).toBe('2.38.2');
      expect(fs.existsSync(paths.containersConfPath)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when Docker and bundled Podman are both unavailable', async () => {
    const execFile = vi.fn(async () => {
      throw new Error('ENOENT');
    });

    await expect(
      resolveContainerRuntime({
        execFile: execFile as never,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        ...systemDockerDeps({ cli: null }),
        resolveBundledPaths: () => null,
      })
    ).rejects.toBeInstanceOf(ContainerRuntimeUnavailableError);
  });

  it('throws when the daemon is unreachable and bundled assets are missing', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'version') {
        return { stdout: '27.0.0\n', stderr: '' };
      }
      throw new Error('Cannot connect to the Docker daemon');
    });

    await expect(
      resolveContainerRuntime({
        execFile: execFile as never,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        ...systemDockerDeps({ reachable: () => false }),
        resolveBundledPaths: () => null,
      })
    ).rejects.toMatchObject({
      name: 'ContainerRuntimeUnavailableError',
      message: expect.stringContaining('daemon'),
    });
  });

  it('allows missing compose version', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'version') {
        return { stdout: '27.0.0\n', stderr: '' };
      }
      if (args[0] === 'info') {
        return { stdout: '27.0.0\n', stderr: '' };
      }
      if (args[0] === 'compose') {
        throw new Error('unknown command');
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    const runtime = await resolveContainerRuntime({
      execFile: execFile as never,
      platform: 'win32',
      arch: 'x64',
      env: {},
      ...systemDockerDeps(),
    });

    expect(runtime.apiEndpoint).toBe('npipe:////./pipe/docker_engine');
    expect(runtime.version.compose).toBeNull();
  });

  it('keeps an explicit DOCKER_HOST and tries nothing else', async () => {
    const deps = systemDockerDeps({ reachable: () => false });
    const execFile = vi.fn(async () => ({ stdout: '27.0.0\n', stderr: '' }));

    await expect(
      resolveContainerRuntime({
        execFile: execFile as never,
        platform: 'darwin',
        arch: 'arm64',
        env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' },
        ...deps,
        resolveBundledPaths: () => null,
      })
    ).rejects.toThrow(/tried tcp:\/\/10\.0\.0\.5:2375\)/);
    expect(deps.pingDocker).toHaveBeenCalledTimes(1);
  });

  it('reads the login shell PATH only when the fixed directories have no CLI', async () => {
    const execFile = vi.fn(async () => ({ stdout: '27.0.0\n', stderr: '' }));
    const readLoginShellPath = vi.fn(async () => '/Users/test/.nix/bin');
    const findDockerCli = vi.fn((dirs: string[]) =>
      dirs.includes('/Users/test/.nix/bin') ? '/Users/test/.nix/bin/docker' : null
    );

    const runtime = await resolveContainerRuntime({
      execFile: execFile as never,
      platform: 'darwin',
      env: {},
      ...systemDockerDeps(),
      readLoginShellPath,
      findDockerCli,
    });
    expect(runtime.cliPath).toBe('/Users/test/.nix/bin/docker');
    expect(readLoginShellPath).toHaveBeenCalledTimes(1);

    readLoginShellPath.mockClear();
    await resolveContainerRuntime({
      execFile: execFile as never,
      platform: 'darwin',
      env: {},
      ...systemDockerDeps(),
      readLoginShellPath,
    });
    expect(readLoginShellPath).not.toHaveBeenCalled();
  });

  it('records why Docker was skipped when the daemon is up but no CLI is found', async () => {
    await expect(
      resolveContainerRuntime({
        execFile: vi.fn() as never,
        platform: 'darwin',
        arch: 'arm64',
        env: {},
        ...systemDockerDeps({ cli: null }),
        resolveBundledPaths: () => null,
      })
    ).rejects.toThrow(/no docker CLI was found/);
    expect(getLastSystemDockerProbe()).toMatchObject({
      endpoint: 'unix:///Users/test/.docker/run/docker.sock',
      endpointSource: 'socket',
      cliPath: null,
    });
  });
});

/** Deps with no Docker and an `ensureBundledMachine` the test settles by hand. */
function makeBundledDeps(root: string) {
  for (const dir of ['bin', 'lib', 'share/krunkit']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of ['bin/podman', 'bin/docker-compose', 'bin/gvproxy', 'bin/krunkit']) {
    fs.writeFileSync(path.join(root, file), '#!/bin/sh\n');
  }
  fs.writeFileSync(path.join(root, 'lib', 'libkrun.dylib'), 'dylib');
  fs.writeFileSync(path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd'), 'fw');
  const binDir = path.join(root, 'bin');
  const stateDir = path.join(root, 'state');
  const paths = {
    root,
    binDir,
    helperDir: binDir,
    libDir: path.join(root, 'lib'),
    firmwarePath: path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd'),
    podmanPath: path.join(binDir, 'podman'),
    composePath: path.join(binDir, 'docker-compose'),
    machineImagePath: null as string | null,
    stateDir,
    containersConfPath: path.join(stateDir, 'containers.conf'),
  };

  const machine = { calls: 0, running: 0, maxRunning: 0 };
  const settlers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  const ensureBundledMachine = vi.fn(
    () =>
      new Promise<{ apiEndpoint: string; dockerHost: string }>((resolve, reject) => {
        machine.calls++;
        machine.running++;
        machine.maxRunning = Math.max(machine.maxRunning, machine.running);
        const endpoint = `unix:///tmp/boundary-${machine.calls}.sock`;
        const done = () => {
          machine.running--;
        };
        const settler = {
          resolve: () => {
            done();
            resolve({ apiEndpoint: endpoint, dockerHost: endpoint });
          },
          reject: (err: Error) => {
            done();
            reject(err);
          },
        };
        settlers.push(settler);
      })
  );

  const deps = {
    execFile: (async () => ({ stdout: '1.0.0\n', stderr: '' })) as never,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    env: {},
    ...systemDockerDeps({ cli: null }),
    resolveBundledPaths: () => paths,
    ensureBundledMachine,
  };
  return { deps, machine, settlers, paths };
}

describe('getContainerRuntime with a reset during a resolve', () => {
  let root: string;

  afterEach(() => {
    resetContainerRuntimeCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function bundledDeps() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-bundled-'));
    return makeBundledDeps(root);
  }

  const machineCalls = async (machine: { calls: number }, n: number) =>
    vi.waitFor(() => expect(machine.calls).toBe(n));

  it('joins the running resolve after a reset instead of starting a second machine', async () => {
    const { deps, machine, settlers } = bundledDeps();
    const first = getContainerRuntime(deps);
    await machineCalls(machine, 1);

    resetContainerRuntimeCache();
    const second = getContainerRuntime(deps);
    settlers[0]!.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    expect(machine.calls).toBe(1);
    expect(machine.maxRunning).toBe(1);
  });

  it('starts one new resolve after a failed one that a reset left running', async () => {
    const { deps, machine, settlers } = bundledDeps();
    const first = getContainerRuntime(deps).catch((err: Error) => err);
    await machineCalls(machine, 1);
    resetContainerRuntimeCache();
    const second = getContainerRuntime(deps).catch((err: Error) => err);

    settlers[0]!.reject(new Error('machine start failed'));
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);

    const third = getContainerRuntime(deps);
    const fourth = getContainerRuntime(deps);
    await machineCalls(machine, 2);
    settlers[1]!.resolve();
    expect(await fourth).toBe(await third);
    expect(machine.maxRunning).toBe(1);
  });

  it('resolves again after a reset once the cached runtime is idle', async () => {
    const { deps, machine, settlers } = bundledDeps();
    const first = getContainerRuntime(deps);
    await machineCalls(machine, 1);
    settlers[0]!.resolve();
    await first;
    await expect(getContainerRuntime(deps)).resolves.toBe(await first);
    expect(machine.calls).toBe(1);

    resetContainerRuntimeCache();
    const again = getContainerRuntime(deps);
    await machineCalls(machine, 2);
    settlers[1]!.resolve();
    await expect(again).resolves.not.toBe(await first);
  });
});

describe('stopBundledMachineIfStarted', () => {
  let root: string | null = null;
  const stopExec = vi.fn(async (_bin: string, args: string[]) => ({
    stdout: args[1] === 'ssh' ? 'oom_kill 0\n' : '',
    stderr: '',
  }));
  const stopCalls = () => stopExec.mock.calls.filter(([, args]) => args[1] === 'stop').length;

  beforeEach(async () => {
    // Tests in the describes above start a bundled machine and leave it marked as started;
    // clear that so each test here starts with none.
    await stopBundledMachineIfStarted((async () => ({ stdout: '', stderr: '' })) as never);
  });

  afterEach(async () => {
    // Clears the started marker so one test's machine never reaches the next.
    await stopBundledMachineIfStarted(stopExec as never);
    stopExec.mockClear();
    resetContainerRuntimeCache();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it('stops the bundled machine this process started', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-bundled-'));
    const { deps, settlers, paths } = makeBundledDeps(root);
    const resolving = getContainerRuntime(deps);
    await vi.waitFor(() => expect(settlers).toHaveLength(1));
    settlers[0]!.resolve();
    await resolving;

    await expect(stopBundledMachineIfStarted(stopExec as never)).resolves.toBe(true);
    expect(stopCalls()).toBe(1);
    // The out-of-memory count is read before the stop resets it.
    expect(stopExec.mock.calls.map(([, args]) => args[1])).toEqual(['ssh', 'stop']);
    expect(stopExec).toHaveBeenCalledWith(
      paths.podmanPath,
      ['machine', 'stop', BOUNDARY_MACHINE_NAME],
      expect.objectContaining({ env: expect.objectContaining({ CONTAINERS_CONF: paths.containersConfPath }) })
    );
    // A second quit step (update install after a failed quit, say) has nothing left to stop.
    await expect(stopBundledMachineIfStarted(stopExec as never)).resolves.toBe(false);
    expect(stopCalls()).toBe(1);
  });

  it('still stops the machine after a Retry cleared the cached runtime', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-bundled-'));
    const { deps, settlers } = makeBundledDeps(root);
    const resolving = getContainerRuntime(deps);
    await vi.waitFor(() => expect(settlers).toHaveLength(1));
    settlers[0]!.resolve();
    await resolving;
    resetContainerRuntimeCache();

    await expect(stopBundledMachineIfStarted(stopExec as never)).resolves.toBe(true);
    expect(stopCalls()).toBe(1);
  });

  it('leaves system Docker alone', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'version' || args[0] === 'info') return { stdout: '27.0.0\n', stderr: '' };
      if (args[0] === 'compose') return { stdout: '2.29.0\n', stderr: '' };
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });
    await getContainerRuntime({
      execFile: execFile as never,
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      ...systemDockerDeps({ reachable: () => true }),
    });

    await expect(stopBundledMachineIfStarted(stopExec as never)).resolves.toBe(false);
    expect(stopExec).not.toHaveBeenCalled();
  });

  it('rejects when podman machine stop fails, so quit can log it', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-bundled-'));
    const { deps, settlers } = makeBundledDeps(root);
    const resolving = getContainerRuntime(deps);
    await vi.waitFor(() => expect(settlers).toHaveLength(1));
    settlers[0]!.resolve();
    await resolving;

    const failing = vi.fn(async () => {
      throw Object.assign(new Error('exit 125'), { stderr: 'machine did not stop' });
    });
    await expect(stopBundledMachineIfStarted(failing as never)).rejects.toThrow(/machine did not stop/);
  });
});

describe('runCli / runCompose', () => {
  const runtime = {
    kind: 'docker' as const,
    origin: 'system' as const,
    cliPath: 'docker',
    composeArgv: ['compose'] as const,
    env: { PATH: '/usr/bin' },
    apiEndpoint: 'unix:///var/run/docker.sock',
    version: { cli: '27', compose: '2' },
  };

  it('prefixes compose argv', () => {
    expect(composeArgv(runtime, ['up', '-d'])).toEqual(['compose', 'up', '-d']);
  });

  it('runCli uses injected execFile', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      expect(args).toEqual(['ps', '-q']);
      return { stdout: 'hello\n', stderr: '' };
    });

    const result = await runCli(runtime, ['ps', '-q'], {
      execFile: execFile as never,
    });
    expect(result.stdout).toBe('hello\n');
  });

  it('runCompose passes compose-prefixed args to execFile', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      expect(args).toEqual(['compose', 'up', '-d']);
      return { stdout: 'ok', stderr: '' };
    });

    await runCompose(runtime, ['up', '-d'], {
      cwd: '/tmp',
      execFile: execFile as never,
    });
    expect(execFile).toHaveBeenCalledOnce();
  });
});

describe('runComposeStreaming timeout', () => {
  const runtime = {
    kind: 'podman' as const,
    origin: 'bundled' as const,
    cliPath: '/bin/sh',
    composeBinaryPath: '/bin/sh',
    composeArgv: [] as const,
    env: { PATH: '/usr/bin:/bin' },
    apiEndpoint: 'unix:///tmp/podman.sock',
    version: { cli: '5', compose: '2' },
  };

  // Each test's fakeChild() ignores SIGTERM: `killed` turns true but it doesn't exit.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends SIGKILL when the child has not exited 5 s after SIGTERM', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const promise = runComposeStreaming(runtime, ['up'], {
      timeout: 100,
      spawnFn: (() => child) as never,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);

    // The child dies but a grandchild keeps stdio open, so `close` never comes.
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ code: null, timedOut: true });
  });

  it('does not send SIGKILL when the child exited after SIGTERM', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const promise = runComposeStreaming(runtime, ['up'], {
      timeout: 100,
      spawnFn: (() => child) as never,
    });

    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 130;
    child.emit('exit', 130, null);
    child.emit('close', 130, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(['SIGTERM']);
    await expect(promise).resolves.toMatchObject({ code: 130, timedOut: true });
  });

  it('stops the child when its signal aborts, as a timeout does, and says it was cancelled', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const controller = new AbortController();
    const promise = runComposeStreaming(runtime, ['pull'], {
      signal: controller.signal,
      spawnFn: (() => child) as never,
    });

    controller.abort();
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    child.signalCode = 'SIGKILL';
    child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toMatchObject({ code: null, timedOut: false, cancelled: true });
  });

  it('stops a child at once when its signal was aborted before the call', async () => {
    const child = fakeChild();
    const controller = new AbortController();
    controller.abort();
    const promise = runComposeStreaming(runtime, ['pull'], {
      signal: controller.signal,
      spawnFn: (() => child) as never,
    });
    expect(child.signals).toEqual(['SIGTERM']);
    child.exitCode = 130;
    child.emit('exit', 130, null);
    child.emit('close', 130, null);
    await expect(promise).resolves.toMatchObject({ code: 130, cancelled: true });
  });

  it('settles for a real process that ignores SIGTERM and leaves a grandchild on its pipes', async () => {
    let grandchildPid: number | null = null;
    try {
      const started = Date.now();
      const result = await runComposeStreaming(
        runtime,
        ['-c', 'trap "" TERM; sleep 30 & echo $! >&2; wait'],
        {
          timeout: 100,
          // Short graces: the defaults (5 s, then 1 s) only make the test wait.
          graceMs: { kill: 100, close: 100 },
          onStderrLine: (line) => {
            grandchildPid = Number.parseInt(line, 10) || null;
          },
        }
      );
      expect(result.timedOut).toBe(true);
      // Settled on the graces, not on the grandchild's 30 s sleep.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }, 15_000);
});
