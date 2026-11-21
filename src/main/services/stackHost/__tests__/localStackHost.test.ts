import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStackPorts } from '../../../../shared/types/assistantStack';
import { createLocalStackHost, type LocalStackHostDeps } from '../localStackHost';
import type { StackCommands } from '../types';

let home: string;
let stack: string;
let userContent: string;

function ports(overrides: Partial<AssistantStackPorts> = {}): AssistantStackPorts {
  return {
    gateway: 8642,
    apiServer: 8643,
    dashboard: 9119,
    webui: 8787,
    searxng: 8888,
    lightrag: 9621,
    neo4jHttp: 7474,
    neo4jBolt: 7687,
    opencode: 4096,
    gptResearcher: 8000,
    n8n: 5678,
    llmProxyAdmin: 4001,
    detector: 8099,
    ...overrides,
  };
}

function commands(): StackCommands {
  return {
    compose: vi.fn(async () => ({ stdout: 'ok', stderr: '' })),
    composeStreaming: vi.fn(async () => ({ stdout: '', stderr: '', code: 0, cancelled: false })),
    scriptEnv: vi.fn(async (profiles: string[]) => ({ COMPOSE_PROFILES: profiles.join(',') })),
    runScript: vi.fn(async () => 0),
    scriptCompose: vi.fn(async () => ({ stdout: '', stderr: '' })),
    scriptCli: vi.fn(async () => ({ stdout: '', stderr: '' })),
  };
}

function host(overrides: Partial<LocalStackHostDeps> = {}) {
  return createLocalStackHost({
    stackRoot: stack,
    userContentRoot: () => userContent,
    ports: () => ports(),
    commands: commands(),
    ...overrides,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-host-'));
  stack = path.join(home, 'project');
  userContent = path.join(home, 'content');
  fs.mkdirSync(stack, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('createLocalStackHost', () => {
  it('is a local host with every capability', () => {
    const h = host();
    expect(h.kind).toBe('local');
    expect(h.capabilities).toEqual({
      hostFolders: true,
      hostCallbacks: true,
      provision: true,
      engineControl: true,
    });
  });

  it('names the stack folder and its data folder on this machine', () => {
    const h = host();
    expect(h.localPaths.stack).toBe(stack);
    expect(h.localPaths.data).toBe(path.join(stack, 'data'));
  });

  it('passes commands through unchanged', async () => {
    const cmds = commands();
    const h = host({ commands: cmds });
    await h.commands.compose(['ps'], { timeout: 5 });
    expect(cmds.compose).toHaveBeenCalledWith(['ps'], { timeout: 5 });
    await expect(h.commands.scriptEnv(['email'])).resolves.toEqual({ COMPOSE_PROFILES: 'email' });
  });
});

describe('local host endpoints', () => {
  it('builds loopback URLs from the ports as they are when asked', () => {
    let current = ports();
    const h = host({ ports: () => current });
    expect(h.endpoints.url('dashboard')).toBe('http://127.0.0.1:9119');
    current = ports({ dashboard: 19119 });
    expect(h.endpoints.url('dashboard', '/api/ws')).toBe('http://127.0.0.1:19119/api/ws');
    expect(h.endpoints.port('apiServer')).toBe(8643);
  });

  it('gives a published port the same number on loopback, under the name asked for', () => {
    const h = host();
    expect(h.endpoints.portUrl(3000, '/metadata')).toBe('http://127.0.0.1:3000/metadata');
    expect(h.endpoints.portUrl(3000, '', 'localhost')).toBe('http://localhost:3000');
  });
});

describe('local host files', () => {
  it('reads null for a missing file and the contents once written', async () => {
    const h = host();
    await expect(h.files.readText('stack', '.env')).resolves.toBeNull();
    await h.files.writeText('stack', '.env', 'A=1\n');
    await expect(h.files.readText('stack', '.env')).resolves.toBe('A=1\n');
    expect(fs.readFileSync(path.join(stack, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('puts data under the stack folder and user content where the resolver says', async () => {
    const h = host();
    await h.files.writeText('data', 'hermes/config.yaml', 'x: 1\n');
    await h.files.writeText('userContent', 'voice/a.txt', 'v');
    expect(fs.readFileSync(path.join(stack, 'data', 'hermes', 'config.yaml'), 'utf8')).toBe('x: 1\n');
    expect(fs.readFileSync(path.join(userContent, 'voice', 'a.txt'), 'utf8')).toBe('v');
  });

  it('resolves user content again on each call', async () => {
    const h = host();
    userContent = path.join(home, 'moved');
    await h.files.writeText('userContent', 'a.txt', 'v');
    expect(fs.existsSync(path.join(home, 'moved', 'a.txt'))).toBe(true);
  });

  it('replaces a file without leaving a temporary file and keeps its mode', async () => {
    const h = host();
    const file = path.join(stack, '.env');
    fs.writeFileSync(file, 'old\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    await h.files.writeText('stack', '.env', 'new\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(stack)).toEqual(['.env']);
  });

  it('gives a new file the mode asked for, and an existing file keeps its own', async () => {
    const h = host();
    await h.files.writeText('data', 'hermes/.env', 'a\n', { mode: 0o600 });
    expect(fs.statSync(path.join(stack, 'data', 'hermes', '.env')).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(stack, 'kept'), '');
    fs.chmodSync(path.join(stack, 'kept'), 0o640);
    await h.files.writeText('stack', 'kept', 'b\n', { mode: 0o600 });
    expect(fs.statSync(path.join(stack, 'kept')).mode & 0o777).toBe(0o640);
  });

  it('lists, makes and removes folders', async () => {
    const h = host();
    await expect(h.files.list('data', 'hermes/profiles')).resolves.toBeNull();
    await h.files.mkdir('data', 'hermes/profiles/a');
    await h.files.writeText('data', 'hermes/profiles/b/.env', '');
    await expect(h.files.exists('data', 'hermes/profiles/a')).resolves.toBe(true);
    expect((await h.files.list('data', 'hermes/profiles'))?.sort()).toEqual(['a', 'b']);
    await h.files.remove('data', 'hermes/profiles/b');
    await expect(h.files.exists('data', 'hermes/profiles/b')).resolves.toBe(false);
    await expect(h.files.remove('data', 'hermes/profiles/missing')).resolves.toBeUndefined();
  });

  it('stats files and folders through links, and null when missing', async () => {
    const h = host();
    await h.files.writeText('stack', 'a.md', 'hello');
    fs.symlinkSync(path.join(stack, 'a.md'), path.join(stack, 'link.md'));
    await expect(h.files.stat('stack', 'a.md')).resolves.toEqual({ kind: 'file', size: 5 });
    await expect(h.files.stat('stack', 'link.md')).resolves.toEqual({ kind: 'file', size: 5 });
    await expect(h.files.stat('stack', '')).resolves.toEqual({ kind: 'folder', size: 0 });
    await expect(h.files.stat('stack', 'missing')).resolves.toBeNull();
  });

  it('renames a folder within its location', async () => {
    const h = host();
    await h.files.writeText('userContent', 'voice/.a.creating/samples/x.md', 'x');
    await h.files.rename('userContent', 'voice/.a.creating', 'voice/a');
    expect(fs.readFileSync(path.join(userContent, 'voice', 'a', 'samples', 'x.md'), 'utf8')).toBe('x');
    await expect(h.files.exists('userContent', 'voice/.a.creating')).resolves.toBe(false);
    await expect(h.files.rename('userContent', 'voice/a', '../a')).rejects.toThrow(/outside/);
  });

  it('resolves links to a path in the location, and null when missing or outside it', async () => {
    const h = host();
    await h.files.writeText('userContent', 'voice/a/STYLE.md', 's');
    fs.writeFileSync(path.join(home, 'secret.md'), 'x');
    fs.symlinkSync(path.join(userContent, 'voice', 'a', 'STYLE.md'), path.join(userContent, 'voice', 'a', 'in.md'));
    fs.symlinkSync(path.join(home, 'secret.md'), path.join(userContent, 'voice', 'a', 'out.md'));
    await expect(h.files.realpath('userContent', 'voice/a/in.md')).resolves.toBe('voice/a/STYLE.md');
    await expect(h.files.realpath('userContent', 'voice/a')).resolves.toBe('voice/a');
    await expect(h.files.realpath('userContent', '.')).resolves.toBe('');
    await expect(h.files.realpath('userContent', 'voice/a/out.md')).resolves.toBeNull();
    await expect(h.files.realpath('userContent', 'voice/a/missing.md')).resolves.toBeNull();
  });

  it('resolves against the real location when the location itself is a link', async () => {
    const real = path.join(home, 'real-content');
    fs.mkdirSync(path.join(real, 'voice'), { recursive: true });
    fs.symlinkSync(real, path.join(home, 'linked'));
    userContent = path.join(home, 'linked');
    const h = host();
    await expect(h.files.realpath('userContent', 'voice')).resolves.toBe('voice');
  });

  it('writes bytes in one step with the mode asked for', async () => {
    const h = host();
    const bytes = Uint8Array.from([0, 255, 10, 13]);
    await h.files.writeBytes('userContent', 'voice/a/samples/b.md', bytes, { mode: 0o600 });
    const file = path.join(userContent, 'voice', 'a', 'samples', 'b.md');
    expect([...fs.readFileSync(file)]).toEqual([0, 255, 10, 13]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['b.md']);
  });

  it('makes a folder with the mode asked for', async () => {
    const h = host();
    await h.files.mkdir('userContent', 'addons/twenty/secrets', { mode: 0o700 });
    expect(fs.statSync(path.join(userContent, 'addons', 'twenty', 'secrets')).mode & 0o777).toBe(0o700);
  });

  it('refuses paths that leave their location', async () => {
    const h = host();
    await expect(h.files.readText('data', '../.env')).rejects.toThrow(/outside/);
    await expect(h.files.writeText('stack', '/etc/hosts', '')).rejects.toThrow(/relative/);
    await expect(h.files.remove('stack', '')).rejects.toThrow(/itself/);
    expect(fs.existsSync(stack)).toBe(true);
  });
});
