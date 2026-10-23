import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBundledRuntimeEnv,
  buildContainersConf,
  ensureContainersConf,
} from '../containerRuntime/containersConf';
import { composeArgv, runCompose } from '../containerRuntime/runCli';
import type { BundledRuntimePaths } from '../containerRuntime/bundledPaths';
import type { ContainerRuntime } from '../containerRuntime/types';

function fakePaths(root: string): BundledRuntimePaths {
  const binDir = path.join(root, 'bin');
  return {
    root,
    binDir,
    helperDir: binDir,
    libDir: path.join(root, 'lib'),
    firmwarePath: path.join(root, 'share', 'krunkit', 'KRUN_EFI.silent.fd'),
    podmanPath: path.join(root, 'bin', 'podman'),
    composePath: path.join(root, 'bin', 'docker-compose'),
    machineImagePath: null,
    stateDir: path.join(root, 'state'),
    containersConfPath: path.join(root, 'state', 'containers.conf'),
  };
}

describe('containersConf', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('buildContainersConf includes helper dir and provider', () => {
    const conf = buildContainersConf({
      helperBinariesDir: '/Apps/Boundary.app/Contents/Resources/container-runtime/darwin-arm64/bin',
      provider: 'libkrun',
    });
    expect(conf).toContain('helper_binaries_dir = ["/Apps/Boundary.app/Contents/Resources/container-runtime/darwin-arm64/bin"]');
    expect(conf).toContain('provider = "libkrun"');
  });

  it('ensureContainersConf writes the file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-conf-'));
    tmpRoots.push(root);
    const paths = fakePaths(root);
    const written = await ensureContainersConf(paths, 'arm64');
    expect(written).toBe(paths.containersConfPath);
    const content = fs.readFileSync(paths.containersConfPath, 'utf8');
    expect(content).toContain('libkrun');
    expect(content).toContain(paths.helperDir.replace(/\\/g, '/'));
  });

  it('ensureContainersConf keeps applehv once selected', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-conf-'));
    tmpRoots.push(root);
    const paths = fakePaths(root);
    await ensureContainersConf(paths, 'arm64', 'applehv');
    await ensureContainersConf(paths, 'arm64');
    const content = fs.readFileSync(paths.containersConfPath, 'utf8');
    expect(content).toContain('provider = "applehv"');
  });

  it('buildBundledRuntimeEnv sets CONTAINERS_CONF and PATH', () => {
    const root = '/rt';
    const paths = fakePaths(root);
    const env = buildBundledRuntimeEnv(paths, { PATH: '/usr/bin', HOME: '/Users/x' }, 'unix:///tmp/podman.sock');
    expect(env.CONTAINERS_CONF).toBe(paths.containersConfPath);
    expect(env.DOCKER_HOST).toBe('unix:///tmp/podman.sock');
    expect(env.PATH?.startsWith(`${paths.binDir}${path.delimiter}`)).toBe(true);
    expect(env.CONTAINERS_LOG_LEVEL).toBeUndefined();
    expect(env.CONTAINERS_MACHINE_PROVIDER).toMatch(/^(libkrun|applehv)$/);
  });
});

describe('runCompose with composeBinaryPath', () => {
  it('invokes standalone compose binary with bare args', async () => {
    const execFile = vi.fn(async (bin: string, args: string[]) => {
      expect(bin).toBe('/vendored/docker-compose');
      expect(args).toEqual(['-f', 'docker-compose.yml', 'up', '-d']);
      return { stdout: 'ok', stderr: '' };
    });

    const runtime: ContainerRuntime = {
      kind: 'podman',
      origin: 'bundled',
      cliPath: '/vendored/podman',
      composeBinaryPath: '/vendored/docker-compose',
      composeArgv: [],
      env: { PATH: '/usr/bin' },
      apiEndpoint: 'unix:///tmp/podman.sock',
      version: { cli: '6.0.1', compose: '2.38.2' },
    };

    expect(composeArgv(runtime, ['up'])).toEqual(['up']);
    await runCompose(runtime, ['-f', 'docker-compose.yml', 'up', '-d'], {
      execFile: execFile as never,
    });
    expect(execFile).toHaveBeenCalledOnce();
  });
});
