import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dockerCliSearchDirs,
  dockerEndpointCandidates,
  findExecutable,
  findReachableDockerEndpoint,
  pathWithDockerCli,
  readDockerContextEndpoint,
  readLoginShellPath,
  resetLoginShellPathCache,
} from '../containerRuntime/systemDocker';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-docker-home-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  resetLoginShellPathCache();
});

function writeContext(name: string, host: string, current = true): void {
  const dockerDir = path.join(home, '.docker');
  const metaDir = path.join(
    dockerDir,
    'contexts',
    'meta',
    createHash('sha256').update(name).digest('hex')
  );
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(
    path.join(metaDir, 'meta.json'),
    JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } })
  );
  if (current) {
    fs.writeFileSync(path.join(dockerDir, 'config.json'), JSON.stringify({ currentContext: name }));
  }
}

describe('readDockerContextEndpoint', () => {
  it('reads the current context endpoint from its meta.json', () => {
    writeContext('colima', 'unix:///Users/x/.colima/default/docker.sock');
    expect(readDockerContextEndpoint({}, home)).toEqual({
      context: 'colima',
      endpoint: 'unix:///Users/x/.colima/default/docker.sock',
    });
  });

  it('lets DOCKER_CONTEXT override config.json', () => {
    writeContext('orbstack', 'unix:///orb.sock');
    writeContext('other', 'unix:///other.sock', false);
    expect(readDockerContextEndpoint({ DOCKER_CONTEXT: 'other' }, home)?.endpoint).toBe(
      'unix:///other.sock'
    );
  });

  it('returns null for the default context or no config', () => {
    expect(readDockerContextEndpoint({}, home)).toBeNull();
    fs.mkdirSync(path.join(home, '.docker'));
    fs.writeFileSync(
      path.join(home, '.docker', 'config.json'),
      JSON.stringify({ currentContext: 'default' })
    );
    expect(readDockerContextEndpoint({}, home)).toBeNull();
  });
});

describe('dockerEndpointCandidates', () => {
  it('uses only DOCKER_HOST when it is set', () => {
    writeContext('colima', 'unix:///colima.sock');
    expect(dockerEndpointCandidates({ DOCKER_HOST: 'tcp://h:2375' }, home, 'darwin')).toEqual([
      { endpoint: 'tcp://h:2375', source: 'DOCKER_HOST' },
    ]);
  });

  it('puts the context first, then well-known sockets with /var/run last', () => {
    writeContext('colima', `unix://${home}/.colima/default/docker.sock`);
    const candidates = dockerEndpointCandidates({}, home, 'darwin');
    expect(candidates[0]).toEqual({
      endpoint: `unix://${home}/.colima/default/docker.sock`,
      source: 'context',
      context: 'colima',
    });
    expect(candidates.map((c) => c.endpoint)).toEqual([
      `unix://${home}/.colima/default/docker.sock`,
      `unix://${home}/.docker/run/docker.sock`,
      `unix://${home}/.orbstack/run/docker.sock`,
      `unix://${home}/.rd/docker.sock`,
      'unix:///var/run/docker.sock',
    ]);
  });

  it('uses the named pipe on Windows', () => {
    expect(dockerEndpointCandidates({}, home, 'win32')).toEqual([
      { endpoint: 'npipe:////./pipe/docker_engine', source: 'socket' },
    ]);
  });
});

describe('findReachableDockerEndpoint', () => {
  it('returns the first endpoint that answers and records the misses', async () => {
    const ping = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'unix:///b.sock') throw new Error('ECONNREFUSED');
    });
    const { winner, attempts } = await findReachableDockerEndpoint(
      [
        { endpoint: 'unix:///a.sock', source: 'socket' },
        { endpoint: 'unix:///b.sock', source: 'socket' },
        { endpoint: 'unix:///c.sock', source: 'socket' },
      ],
      ping
    );
    expect(winner?.endpoint).toBe('unix:///b.sock');
    expect(attempts).toEqual([
      { endpoint: 'unix:///a.sock', source: 'socket', ok: false, error: 'ECONNREFUSED' },
      { endpoint: 'unix:///b.sock', source: 'socket', ok: true },
    ]);
    expect(ping).toHaveBeenCalledTimes(2);
  });
});

describe('docker CLI search', () => {
  it('searches inherited PATH, well-known dirs, then the login shell PATH', () => {
    const dirs = dockerCliSearchDirs(
      { PATH: '/usr/bin:/bin' },
      home,
      '/Users/x/.nix/bin:/usr/bin'
    );
    expect(dirs.slice(0, 4)).toEqual(['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin']);
    expect(dirs).toContain(path.join(home, '.docker', 'bin'));
    expect(dirs).toContain('/Applications/Docker.app/Contents/Resources/bin');
    expect(dirs[dirs.length - 1]).toBe('/Users/x/.nix/bin');
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1);
  });

  it('finds an executable file and skips non-executable ones', () => {
    const a = path.join(home, 'a');
    const b = path.join(home, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'docker'), '', { mode: 0o644 });
    fs.writeFileSync(path.join(b, 'docker'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findExecutable('docker', [path.join(home, 'none'), a, b])).toBe(path.join(b, 'docker'));
    expect(findExecutable('docker', [a])).toBeNull();
  });

  it('puts the CLI directory first in PATH', () => {
    expect(pathWithDockerCli('/opt/x/docker', ['/usr/bin', '/opt/x'])).toBe('/opt/x:/usr/bin');
  });
});

describe('readLoginShellPath', () => {
  it('extracts PATH after the marker and caches it', async () => {
    const run = vi.fn(async () => ({
      stdout: 'motd noise\n__BOUNDARY_LOGIN_PATH__=/opt/homebrew/bin:/usr/bin\n',
      stderr: '',
    }));
    expect(await readLoginShellPath({ SHELL: '/bin/zsh' }, run as never)).toBe(
      '/opt/homebrew/bin:/usr/bin'
    );
    await readLoginShellPath({ SHELL: '/bin/zsh' }, run as never);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-ilc', expect.any(String)], expect.objectContaining({ timeout: 5_000 }));
  });

  it('returns null when the shell fails or times out', async () => {
    const run = vi.fn(async () => {
      throw new Error('timed out');
    });
    expect(await readLoginShellPath({}, run as never)).toBeNull();
  });
});
