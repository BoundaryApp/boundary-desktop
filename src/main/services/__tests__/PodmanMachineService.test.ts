import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PodmanMachineService,
  activeMachineFromError,
  findMachineHelperPids,
  resetApplehvFallbackGate,
} from '../containerRuntime/PodmanMachineService';
import { ContainerRuntimeUnavailableError } from '../containerRuntime/types';

// ensureRunning reaps leftover helpers from `ps` before a start. Give it an empty
// listing so a test run never signals real processes on the developer's machine.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  };
});

type PodmanCommand = 'list' | 'inspect' | 'start' | 'init' | 'rm' | 'set' | 'ssh' | 'stop' | 'info';
/** The stdout to answer with, or a function that returns it or throws. */
type PodmanReply = string | ((args: string[], options: { timeout: number }) => string | Promise<string>);

/**
 * Stands in for the `podman` CLI behind PodmanMachineService's `execFile`. Routes each call on
 * its command (`machine list` → `list`, `info` → `info`) and throws on any command without a
 * route. A list of replies answers successive calls in turn and then repeats its last one.
 */
function fakePodman(routes: Partial<Record<PodmanCommand, PodmanReply | PodmanReply[]>>) {
  const calls: string[][] = [];
  const used = new Map<string, number>();
  const execFile = vi.fn(async (_bin: string, args: string[], options: { timeout: number }) => {
    calls.push(args);
    // A leading `--url <socket>` picks the connection; route on the command after it.
    const rest = args[0] === '--url' ? args.slice(2) : args;
    const command = (rest[0] === 'machine' ? rest[1] : rest[0]) as PodmanCommand;
    const route = routes[command];
    if (route === undefined) throw new Error(`unexpected ${args.join(' ')}`);
    const replies = Array.isArray(route) ? route : [route];
    const n = used.get(command) ?? 0;
    used.set(command, n + 1);
    const reply = replies[Math.min(n, replies.length - 1)];
    return { stdout: typeof reply === 'string' ? reply : await reply(args, options), stderr: '' };
  });
  const ran = (command: PodmanCommand) => calls.some((c) => c[1] === command);
  return { execFile, calls, ran };
}

/** `machine inspect` output for a rootful machine with its API socket at `socket`. */
function inspectJson(fields: Record<string, unknown> = {}, socket = '/tmp/p.sock'): string {
  return JSON.stringify({ ConnectionInfo: { PodmanSocket: { Path: socket } }, Rootful: true, ...fields });
}

function service(
  execFile: (bin: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>,
  deps: { env?: NodeJS.ProcessEnv; machineImagePath?: string; memoryMiB?: number } = {}
) {
  return new PodmanMachineService({
    execFile: execFile as never,
    env: {},
    podmanPath: '/podman',
    // A fixed size unless a test says otherwise, so results don't depend on the Mac running them.
    memoryMiB: 12288,
    ...deps,
  });
}

/** The error Podman gives when krunkit can't launch the VM. */
function krunkitFailure(): never {
  const err = new Error('krunkit exited unexpectedly with exit code 1') as Error & { stderr: string };
  err.stderr = 'Error: krunkit exited unexpectedly with exit code 1\n';
  throw err;
}

describe('PodmanMachineService', () => {
  afterEach(() => {
    resetApplehvFallbackGate();
  });
  it('reports missing when machine is not listed', async () => {
    const { execFile } = fakePodman({ list: 'podman-machine-default\ttrue\n' });
    await expect(service(execFile).status()).resolves.toBe('missing');
  });

  it('reports running / stopped from list output', async () => {
    const { execFile } = fakePodman({ list: ['boundary\ttrue\n', 'boundary\tfalse\n'] });
    const svc = service(execFile);
    await expect(svc.status()).resolves.toBe('running');
    await expect(svc.status()).resolves.toBe('stopped');
  });

  it('treats default-marker names (boundary*) as the boundary machine', async () => {
    const { execFile } = fakePodman({ list: 'boundary*\tfalse\n' });
    await expect(service(execFile).status()).resolves.toBe('stopped');
  });

  it('starts instead of init when list uses a trailing asterisk', async () => {
    const { execFile, ran } = fakePodman({
      list: ['boundary*\tfalse\n', 'boundary*\ttrue\n'],
      start: '',
      inspect: inspectJson(),
      info: '/tmp/p.sock\n',
    });
    await service(execFile).ensureRunning();
    expect(ran('init')).toBe(false);
    expect(ran('start')).toBe(true);
  });

  it('inits when missing then resolves socket', async () => {
    const { execFile, calls, ran } = fakePodman({
      list: '',
      init: 'ok',
      inspect: inspectJson({}, '/tmp/boundary-podman.sock'),
      info: '/tmp/boundary-podman.sock\n',
    });

    const progress: string[] = [];
    const svc = service(execFile, { env: { CONTAINERS_CONF: '/tmp/c.conf' }, machineImagePath: '/img/machine-os.zst' });

    const result = await svc.ensureRunning((m) => progress.push(m));
    expect(result.apiEndpoint).toBe('unix:///tmp/boundary-podman.sock');
    expect(result.dockerHost).toBe('unix:///tmp/boundary-podman.sock');
    expect(ran('init')).toBe(true);
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
    expect(progress).toEqual([
      'Creating Boundary container engine (first run may take a few minutes)…',
      'Using bundled machine image…',
      'Waiting for container API socket…',
    ]);
  });

  it('starts when stopped', async () => {
    const { execFile, ran } = fakePodman({
      list: ['boundary\tfalse\n', 'boundary\ttrue\n'],
      start: '',
      inspect: `[${inspectJson()}]`,
      info: '/tmp/p.sock\n',
    });
    const result = await service(execFile).ensureRunning();
    expect(result.status).toBe('running');
    expect(ran('start')).toBe(true);
  });

  it('converts a stopped rootless machine to rootful before start', async () => {
    const { execFile, calls, ran } = fakePodman({
      list: 'boundary\tfalse\n',
      set: (args) => {
        if (!args.includes('--rootful')) throw new Error(`unexpected ${args.join(' ')}`);
        return '';
      },
      start: '',
      inspect: inspectJson({ Rootful: false }),
      info: '/tmp/p.sock\n',
    });

    const progress: string[] = [];
    await service(execFile).ensureRunning((m) => progress.push(m));
    expect(calls.some((c) => c[1] === 'set' && c.includes('--rootful'))).toBe(true);
    expect(ran('start')).toBe(true);
    expect(progress.some((m) => /rootful/i.test(m))).toBe(true);
  });

  it('no-ops init/start when already running', async () => {
    const { execFile, ran } = fakePodman({ list: 'boundary\ttrue\n', inspect: inspectJson(), info: 'ok\n' });
    await service(execFile).ensureRunning();
    expect(ran('init')).toBe(false);
    expect(ran('start')).toBe(false);
  });

  it('falls back to applehv when start fails because krunkit cannot launch', async () => {
    const env: NodeJS.ProcessEnv = {};
    const { execFile, calls, ran } = fakePodman({
      list: 'boundary*\tfalse\n',
      start: krunkitFailure,
      rm: '',
      init: () => {
        expect(env.CONTAINERS_MACHINE_PROVIDER).toBe('applehv');
        return 'ok';
      },
      inspect: inspectJson({ Name: 'boundary', State: 'stopped', VMType: 'libkrun' }),
      info: '/tmp/p.sock\n',
    });

    const progress: string[] = [];
    const result = await service(execFile, { env }).ensureRunning((m) => progress.push(m));
    expect(result.status).toBe('running');
    expect(ran('start')).toBe(true);
    expect(calls.some((c) => c[1] === 'rm' && c.includes('-f'))).toBe(true);
    expect(ran('init')).toBe(true);
    expect(env.CONTAINERS_MACHINE_PROVIDER).toBe('applehv');
    expect(progress.some((m) => /Apple Virtualization/i.test(m))).toBe(true);
  });

  it('does not rm the machine again if applehv fallback already ran', async () => {
    const { execFile, calls } = fakePodman({
      list: 'boundary*\tfalse\n',
      start: krunkitFailure,
      rm: '',
      init: 'ok',
      inspect: inspectJson(),
      info: '/tmp/p.sock\n',
    });
    const svc = service(execFile);
    const count = (command: string) => calls.filter((c) => c[1] === command).length;
    await svc.ensureRunning();
    expect(count('rm')).toBe(1);

    await expect(svc.ensureRunning()).rejects.toBeInstanceOf(ContainerRuntimeUnavailableError);
    expect(count('start')).toBe(2);
    expect(count('rm')).toBe(1);
  });

  it('surfaces failures as ContainerRuntimeUnavailableError', async () => {
    const execFile = vi.fn(async () => {
      const err = new Error('boom') as Error & { stderr: string };
      err.stderr = 'machine init failed';
      throw err;
    });
    const svc = service(execFile);
    // force missing then init fail
    vi.spyOn(svc, 'status').mockResolvedValue('missing');
    await expect(svc.ensureRunning()).rejects.toBeInstanceOf(ContainerRuntimeUnavailableError);
  });
});

describe('PodmanMachineService with another machine active', () => {
  const refusal = (name: string) => {
    const err = new Error('exit status 125') as Error & { stderr?: string };
    err.stderr = `Error: ${name} already starting or running on the libkrun provider: only one VM can be active at a time\n`;
    return err;
  };

  function setup(active: string, containers: string) {
    let refused = false;
    const { execFile, calls } = fakePodman({
      list: () => `boundary\t${refused ? 'true' : 'false'}\n`,
      start: () => {
        if (!refused) {
          refused = true;
          throw refusal(active);
        }
        return '';
      },
      ssh: containers,
      stop: '',
      inspect: `[${inspectJson()}]`,
      info: '/tmp/p.sock\n',
    });
    const svc = service(execFile);
    const stopped = () => calls.filter((a) => a[1] === 'stop').map((a) => a[2]);
    return { svc, stopped };
  }

  it('stops an idle copy of Boundary’s machine and starts its own', async () => {
    const { svc, stopped } = setup('boundary-beta', '');
    await expect(svc.ensureRunning()).resolves.toMatchObject({ status: 'running' });
    expect(stopped()).toEqual(['boundary-beta']);
  });

  it('leaves a machine with running containers alone', async () => {
    const { svc, stopped } = setup('boundary-beta', 'abc123\n');
    await expect(svc.ensureRunning()).rejects.toThrow(/only one VM can be active/);
    expect(stopped()).toEqual([]);
  });

  it('leaves a machine that isn’t Boundary’s alone', async () => {
    const { svc, stopped } = setup('podman-machine-default', '');
    await expect(svc.ensureRunning()).rejects.toThrow(/only one VM can be active/);
    expect(stopped()).toEqual([]);
  });

  it('reads the machine name from the refusal, with or without a provider', () => {
    expect(activeMachineFromError(refusal('boundary-beta').stderr ?? '')).toBe('boundary-beta');
    expect(
      activeMachineFromError('boundary already starting or running: only one VM can be active at a time')
    ).toBe('boundary');
    expect(activeMachineFromError('krunkit exited unexpectedly')).toBeNull();
  });
});

describe('PodmanMachineService socket wait', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a machine whose API never answers within 90 s overall', async () => {
    vi.useFakeTimers();
    const timeouts: number[] = [];
    const { execFile } = fakePodman({
      list: 'boundary\ttrue\n',
      inspect: inspectJson(),
      // A hung machine: execFile only gives up when its timeout fires.
      info: (_args, options) => {
        timeouts.push(options.timeout);
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('timed out')), options.timeout);
        });
      },
    });
    const svc = service(execFile);

    const started = Date.now();
    let failedAt = 0;
    const result = svc.ensureRunning().catch((error: unknown) => {
      failedAt = Date.now();
      return error;
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await result;

    expect(error).toBeInstanceOf(ContainerRuntimeUnavailableError);
    expect((error as Error).message).toMatch(/Timed out waiting for Podman machine socket/);
    expect(failedAt - started).toBeLessThanOrEqual(90_000);
    expect(Math.max(...timeouts)).toBeLessThanOrEqual(15_000);
    expect(timeouts.every((t) => t > 0)).toBe(true);
  });
});

describe('findMachineHelperPids', () => {
  const tmp = '/var/folders/x/T/podman';
  const machineDir = '/Users/u/.local/share/containers/podman/machine';
  const helpers = '/Applications/Boundary.app/Contents/Resources/podman/bin';

  it("matches the boundary machine's own krunkit, gvproxy and vfkit", () => {
    const ps = [
      `  1001 ${helpers}/gvproxy -mtu 1500 -listen-vfkit unixgram://${tmp}/boundary-gvproxy.sock -forward-sock ${tmp}/boundary-api.sock -pid-file ${tmp}/gvproxy.pid`,
      `  1002 ${helpers}/krunkit --cpus 4 --device virtio-blk,path=${machineDir}/libkrun/boundary-arm64.raw --device virtio-net,unixSocketPath=${tmp}/boundary-gvproxy.sock,mac=5a:94:ef:e4:0c:ee`,
      `  1003 ${helpers}/vfkit --device virtio-blk,path=${machineDir}/applehv/boundary-arm64.raw --device virtio-vsock,port=1025,socketURL=${tmp}/boundary.sock,listen`,
    ].join('\n');
    expect(findMachineHelperPids(ps, 'boundary')).toEqual([1001, 1002, 1003]);
  });

  it('leaves other machines and non-helper processes alone', () => {
    const ps = [
      // Another machine whose name starts with "boundary".
      `  2001 /opt/homebrew/bin/gvproxy -listen-vfkit unixgram://${tmp}/boundary-test-gvproxy.sock -forward-sock ${tmp}/boundary-test-api.sock`,
      `  2002 /opt/homebrew/bin/krunkit --device virtio-blk,path=${machineDir}/libkrun/boundary-test-arm64.raw`,
      // podman-machine-default run from a checkout named boundary-desktop.
      `  3001 /Users/u/src/boundary-desktop/resources/podman/bin/vfkit --device virtio-blk,path=${machineDir}/applehv/podman-machine-default-arm64.raw`,
      // Tools whose arguments name a helper and this machine's files.
      `  4001 tail -f /Users/u/Library/Logs/boundary-desktop/krunkit.log ${tmp}/boundary-gvproxy.sock`,
      `  4002 /usr/bin/vim ${tmp}/boundary-gvproxy.sock gvproxy`,
      `  4003 grep -E krunkit|gvproxy|vfkit boundary-arm64.raw`,
      `  4004 /usr/bin/less /opt/gvproxy ${tmp}/boundary.sock`,
      // Unrelated helper.
      `  5001 /opt/homebrew/bin/gvproxy -listen-vfkit unixgram://${tmp}/podman-machine-default-gvproxy.sock`,
      '',
    ].join('\n');
    expect(findMachineHelperPids(ps, 'boundary')).toEqual([]);
  });

  it('treats the machine name literally', () => {
    const ps = `  6001 ${helpers}/gvproxy -listen-vfkit unixgram://${tmp}/boundaryX-gvproxy.sock`;
    expect(findMachineHelperPids(ps, 'boundary')).toEqual([]);
    expect(findMachineHelperPids(ps, 'boundaryX')).toEqual([6001]);
  });
});

describe('PodmanMachineService memory', () => {
  it('creates the machine at the size it is given', async () => {
    const { execFile, calls } = fakePodman({ list: '', init: 'ok', inspect: inspectJson(), info: '/tmp/p.sock\n' });
    await service(execFile, { memoryMiB: 4096 }).ensureRunning();
    const init = calls.find((c) => c[1] === 'init')!;
    expect(init[init.indexOf('--memory') + 1]).toBe('4096');
  });

  it('leaves a running machine that is too large alone until its next start', async () => {
    const { execFile, ran } = fakePodman({
      list: 'boundary\ttrue\n',
      inspect: inspectJson({ Resources: { Memory: 12288 } }),
      info: '/tmp/p.sock\n',
    });
    await service(execFile, { memoryMiB: 5120 }).ensureRunning();
    expect(ran('set')).toBe(false);
    expect(ran('stop')).toBe(false);
  });

  it('shrinks a stopped machine before starting it', async () => {
    const { execFile, calls } = fakePodman({
      list: ['boundary\tfalse\n', 'boundary\ttrue\n'],
      inspect: inspectJson({ Resources: { Memory: 12288 } }),
      set: '',
      start: '',
      info: '/tmp/p.sock\n',
    });
    const progress: string[] = [];
    await service(execFile, { memoryMiB: 5120 }).ensureRunning((m) => progress.push(m));
    const set = calls.findIndex((c) => c[1] === 'set' && c.includes('--memory'));
    expect(calls[set]![calls[set]!.indexOf('--memory') + 1]).toBe('5120');
    expect(set).toBeLessThan(calls.findIndex((c) => c[1] === 'start'));
    expect(progress).toContain('Reducing container engine memory (12288 → 5120 MiB)…');
  });

  it('leaves a stopped machine within 1 GiB of its size alone', async () => {
    const { execFile, ran } = fakePodman({
      list: ['boundary\tfalse\n', 'boundary\ttrue\n'],
      inspect: inspectJson({ Resources: { Memory: 5632 } }),
      start: '',
      info: '/tmp/p.sock\n',
    });
    await service(execFile, { memoryMiB: 5120 }).ensureRunning();
    expect(ran('set')).toBe(false);
  });

  it('reads the VM\'s out-of-memory kill count', async () => {
    const { execFile, calls } = fakePodman({ ssh: 'oom_kill 3\n' });
    await expect(service(execFile).oomKillCount()).resolves.toBe(3);
    expect(calls[0]).toEqual(['machine', 'ssh', 'boundary', 'grep', '^oom_kill ', '/proc/vmstat']);
  });

  it('gives null when the count can\'t be read', async () => {
    const failing = fakePodman({
      ssh: () => {
        throw new Error('ssh: connect refused');
      },
    });
    await expect(service(failing.execFile).oomKillCount()).resolves.toBeNull();
    const empty = fakePodman({ ssh: '' });
    await expect(service(empty.execFile).oomKillCount()).resolves.toBeNull();
  });

  it('checks the machine it started, not Podman\'s default connection', async () => {
    // Another machine (an older Boundary build, Podman Desktop) can be the shared default.
    const { execFile, calls } = fakePodman({
      list: 'boundary\ttrue\n',
      inspect: inspectJson({}, '/tmp/boundary-api.sock'),
      info: '/run/podman/podman.sock\n',
    });
    await service(execFile).ensureRunning();
    const info = calls.find((c) => c.includes('info'))!;
    expect(info.slice(0, 3)).toEqual(['--url', 'unix:///tmp/boundary-api.sock', 'info']);
  });

  it('grows a machine smaller than this Mac\'s size', async () => {
    const { execFile, calls } = fakePodman({
      list: ['boundary\tfalse\n', 'boundary\ttrue\n'],
      inspect: inspectJson({ Resources: { Memory: 2048 } }),
      set: '',
      start: '',
      info: '/tmp/p.sock\n',
    });
    await service(execFile, { memoryMiB: 8192 }).ensureRunning();
    const set = calls.find((c) => c[1] === 'set' && c.includes('--memory'))!;
    expect(set[set.indexOf('--memory') + 1]).toBe('8192');
  });
});
