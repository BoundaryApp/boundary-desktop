import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundledRuntimeAssetsPresent,
  darwinRuntimeArch,
  getBundledRuntimeRoot,
  getContainerRuntimeStateDir,
  machineProviderForArch,
  resolveBundledRuntimePaths,
} from '../containerRuntime/bundledPaths';

describe('bundledPaths', () => {
  const tmpRoots: string[] = [];

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function makeAssetTree(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-rt-'));
    tmpRoots.push(root);
    const archRoot = path.join(root, 'container-runtime', 'darwin-arm64');
    fs.mkdirSync(path.join(archRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(archRoot, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(archRoot, 'share', 'krunkit'), { recursive: true });
    fs.writeFileSync(path.join(archRoot, 'bin', 'podman'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(archRoot, 'bin', 'docker-compose'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(archRoot, 'bin', 'gvproxy'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(archRoot, 'bin', 'krunkit'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(archRoot, 'lib', 'libkrun.dylib'), 'dylib');
    fs.writeFileSync(path.join(archRoot, 'share', 'krunkit', 'KRUN_EFI.silent.fd'), 'fw');
    fs.chmodSync(path.join(archRoot, 'bin', 'podman'), 0o755);
    fs.chmodSync(path.join(archRoot, 'bin', 'docker-compose'), 0o755);
    fs.chmodSync(path.join(archRoot, 'bin', 'gvproxy'), 0o755);
    fs.chmodSync(path.join(archRoot, 'bin', 'krunkit'), 0o755);
    return root;
  }

  it('maps darwin arches', () => {
    expect(darwinRuntimeArch('arm64')).toBe('arm64');
    expect(darwinRuntimeArch('x64')).toBe('x64');
    expect(darwinRuntimeArch('ia32')).toBeNull();
  });

  it('picks libkrun on arm64 and applehv on x64', () => {
    expect(machineProviderForArch('arm64')).toBe('libkrun');
    expect(machineProviderForArch('x64')).toBe('applehv');
  });

  it('resolves bundled root from resourcesPath when podman exists', () => {
    const resources = makeAssetTree();
    const resolved = getBundledRuntimeRoot({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: resources,
      projectRoot: '/nonexistent',
    });
    expect(resolved).toBe(path.join(resources, 'container-runtime', 'darwin-arm64'));
  });

  it('returns null root on non-darwin', () => {
    expect(
      getBundledRuntimeRoot({
        platform: 'linux',
        arch: 'arm64',
        resourcesPath: '/tmp',
      })
    ).toBeNull();
  });

  it('resolveBundledRuntimePaths reports assets and state paths', () => {
    const resources = makeAssetTree();
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-ud-'));
    tmpRoots.push(userData);

    const paths = resolveBundledRuntimePaths({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: resources,
      projectRoot: '/nonexistent',
      userDataRoot: userData,
    });

    expect(paths).not.toBeNull();
    expect(bundledRuntimeAssetsPresent(paths!)).toBe(true);
    expect(paths!.podmanPath).toContain(`${path.sep}bin${path.sep}podman`);
    expect(paths!.composePath).toContain(`${path.sep}bin${path.sep}docker-compose`);
    expect(paths!.stateDir).toBe(getContainerRuntimeStateDir(userData));
    expect(paths!.containersConfPath).toBe(path.join(userData, 'container-runtime', 'containers.conf'));
    expect(paths!.machineImagePath).toBeNull();
    expect(paths!.helperDir).toBe(paths!.binDir);
    expect(paths!.libDir).toContain(`${path.sep}lib`);
    expect(paths!.firmwarePath).toContain(`${path.sep}share${path.sep}krunkit${path.sep}KRUN_EFI.silent.fd`);
  });

  it('treats missing krunkit firmware as incomplete arm64 assets', () => {
    const resources = makeAssetTree();
    const archRoot = path.join(resources, 'container-runtime', 'darwin-arm64');
    fs.rmSync(path.join(archRoot, 'share', 'krunkit', 'KRUN_EFI.silent.fd'));
    const paths = resolveBundledRuntimePaths({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: resources,
      projectRoot: '/nonexistent',
      userDataRoot: path.join(resources, 'ud'),
    });
    expect(paths).not.toBeNull();
    expect(bundledRuntimeAssetsPresent(paths!)).toBe(false);
  });
});
