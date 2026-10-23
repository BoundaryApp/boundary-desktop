import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContainerRuntimeUnavailableError,
  composeArgv,
  getLastSystemDockerProbe,
  resetContainerRuntimeCache,
  resolveContainerRuntime,
  runCli,
  runCompose,
} from '../containerRuntime';
import {
  defaultDockerApiEndpoint,
  dockerodeOptionsFromApiEndpoint,
} from '../containerRuntime/apiEndpoint';

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
    readLoginShellPath: async () => null,
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
