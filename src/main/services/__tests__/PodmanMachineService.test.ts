import { afterEach, describe, expect, it, vi } from 'vitest';
import { PodmanMachineService, resetApplehvFallbackGate } from '../containerRuntime/PodmanMachineService';
import { ContainerRuntimeUnavailableError } from '../containerRuntime/types';

describe('PodmanMachineService', () => {
  afterEach(() => {
    resetApplehvFallbackGate();
  });
  it('reports missing when machine is not listed', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: 'podman-machine-default\ttrue\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await expect(svc.status()).resolves.toBe('missing');
  });

  it('reports running / stopped from list output', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'boundary\ttrue\n',
      stderr: '',
    }));
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await expect(svc.status()).resolves.toBe('running');

    execFile.mockResolvedValueOnce({ stdout: 'boundary\tfalse\n', stderr: '' });
    await expect(svc.status()).resolves.toBe('stopped');
  });

  it('treats default-marker names (boundary*) as the boundary machine', async () => {
    const execFile = vi.fn(async () => ({
      stdout: 'boundary*\tfalse\n',
      stderr: '',
    }));
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await expect(svc.status()).resolves.toBe('stopped');
  });

  it('starts instead of init when list uses a trailing asterisk', async () => {
    let listed = false;
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'machine' && args[1] === 'list') {
        if (!listed) {
          listed = true;
          return { stdout: 'boundary*\tfalse\n', stderr: '' };
        }
        return { stdout: 'boundary*\ttrue\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'start') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } },
            Rootful: true,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/p.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await svc.ensureRunning();
    expect(execFile.mock.calls.some((c) => (c[1] as string[])[1] === 'init')).toBe(false);
    expect(execFile.mock.calls.some((c) => (c[1] as string[])[1] === 'start')).toBe(true);
  });

  it('inits when missing then resolves socket', async () => {
    const calls: string[][] = [];
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'init') {
        return { stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/boundary-podman.sock' } },
            Rootful: true,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/boundary-podman.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const progress: string[] = [];
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: { CONTAINERS_CONF: '/tmp/c.conf' },
      podmanPath: '/podman',
      machineImagePath: '/img/machine-os.zst',
    });

    const result = await svc.ensureRunning((m) => progress.push(m));
    expect(result.apiEndpoint).toBe('unix:///tmp/boundary-podman.sock');
    expect(result.dockerHost).toBe('unix:///tmp/boundary-podman.sock');
    expect(calls.some((c) => c[0] === 'machine' && c[1] === 'init')).toBe(true);
    expect(calls.find((c) => c[1] === 'init')).toEqual(
      expect.arrayContaining([
        '--rootful',
        '--image',
        '/img/machine-os.zst',
        '--now',
        '--memory',
        '12288',
      ])
    );
    expect(progress.length).toBeGreaterThan(0);
  });

  it('starts when stopped', async () => {
    let listed = false;
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'machine' && args[1] === 'list') {
        if (!listed) {
          listed = true;
          return { stdout: 'boundary\tfalse\n', stderr: '' };
        }
        return { stdout: 'boundary\ttrue\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'start') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify([
            { ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } }, Rootful: true },
          ]),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/p.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    const result = await svc.ensureRunning();
    expect(result.status).toBe('running');
    expect(execFile.mock.calls.some((c) => (c[1] as string[])[1] === 'start')).toBe(true);
  });

  it('converts a stopped rootless machine to rootful before start', async () => {
    const calls: string[][] = [];
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: 'boundary\tfalse\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'set' && args.includes('--rootful')) {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'start') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            Rootful: false,
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/p.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const progress: string[] = [];
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await svc.ensureRunning((m) => progress.push(m));
    expect(calls.some((c) => c[1] === 'set' && c.includes('--rootful'))).toBe(true);
    expect(calls.some((c) => c[1] === 'start')).toBe(true);
    expect(progress.some((m) => /rootful/i.test(m))).toBe(true);
  });

  it('no-ops init/start when already running', async () => {
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: 'boundary\ttrue\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } },
            Rootful: true,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: 'ok\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    await svc.ensureRunning();
    expect(execFile.mock.calls.some((c) => (c[1] as string[])[1] === 'init')).toBe(false);
    expect(execFile.mock.calls.some((c) => (c[1] as string[])[1] === 'start')).toBe(false);
  });

  it('falls back to applehv when start fails because krunkit cannot launch', async () => {
    const calls: string[][] = [];
    const env: NodeJS.ProcessEnv = {};
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: 'boundary*\tfalse\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'start') {
        const err = new Error('krunkit exited unexpectedly with exit code 1') as Error & {
          stderr: string;
        };
        err.stderr = 'Error: krunkit exited unexpectedly with exit code 1\n';
        throw err;
      }
      if (args[0] === 'machine' && args[1] === 'rm') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'init') {
        expect(env.CONTAINERS_MACHINE_PROVIDER).toBe('applehv');
        return { stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            Name: 'boundary',
            State: 'stopped',
            VMType: 'libkrun',
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } },
            Rootful: true,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/p.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const progress: string[] = [];
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env,
      podmanPath: '/podman',
    });
    const result = await svc.ensureRunning((m) => progress.push(m));
    expect(result.status).toBe('running');
    expect(calls.some((c) => c[1] === 'start')).toBe(true);
    expect(calls.some((c) => c[1] === 'rm' && c.includes('-f'))).toBe(true);
    expect(calls.some((c) => c[1] === 'init')).toBe(true);
    expect(env.CONTAINERS_MACHINE_PROVIDER).toBe('applehv');
    expect(progress.some((m) => /Apple Virtualization/i.test(m))).toBe(true);
  });

  it('does not rm the machine again if applehv fallback already ran', async () => {
    let startAttempts = 0;
    const calls: string[][] = [];
    const env: NodeJS.ProcessEnv = {};
    const execFile = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'machine' && args[1] === 'list') {
        return { stdout: 'boundary*\tfalse\n', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'start') {
        startAttempts += 1;
        const err = new Error('krunkit exited unexpectedly with exit code 1') as Error & {
          stderr: string;
        };
        err.stderr = 'Error: krunkit exited unexpectedly with exit code 1\n';
        throw err;
      }
      if (args[0] === 'machine' && args[1] === 'rm') {
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'init') {
        return { stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'machine' && args[1] === 'inspect') {
        return {
          stdout: JSON.stringify({
            ConnectionInfo: { PodmanSocket: { Path: '/tmp/p.sock' } },
            Rootful: true,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'info') {
        return { stdout: '/tmp/p.sock\n', stderr: '' };
      }
      throw new Error(`unexpected ${args.join(' ')}`);
    });

    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env,
      podmanPath: '/podman',
    });
    await svc.ensureRunning();
    expect(calls.filter((c) => c[1] === 'rm').length).toBe(1);

    await expect(svc.ensureRunning()).rejects.toBeInstanceOf(ContainerRuntimeUnavailableError);
    expect(startAttempts).toBe(2);
    expect(calls.filter((c) => c[1] === 'rm').length).toBe(1);
  });

  it('surfaces failures as ContainerRuntimeUnavailableError', async () => {
    const execFile = vi.fn(async () => {
      const err = new Error('boom') as Error & { stderr: string };
      err.stderr = 'machine init failed';
      throw err;
    });
    const svc = new PodmanMachineService({
      execFile: execFile as never,
      env: {},
      podmanPath: '/podman',
    });
    // force missing then init fail
    vi.spyOn(svc, 'status').mockResolvedValue('missing');
    await expect(svc.ensureRunning()).rejects.toBeInstanceOf(ContainerRuntimeUnavailableError);
  });
});
