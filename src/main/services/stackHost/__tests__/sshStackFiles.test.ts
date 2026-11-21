import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sftpStackFiles } from '../sshStackFiles';
import { sftpOverLocalFiles } from './sshTestDoubles';

describe('sftpStackFiles', () => {
  let root: string;
  let content: string;
  let sftp: ReturnType<typeof sftpOverLocalFiles>;
  let files: ReturnType<typeof sftpStackFiles>;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-stack-')));
    content = path.join(root, 'content');
    fs.mkdirSync(path.join(root, 'stack'), { recursive: true });
    sftp = sftpOverLocalFiles();
    files = sftpStackFiles(sftp, { stackRoot: path.join(root, 'stack'), userContentRoot: async () => content });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads null for a missing file and writes through a temp file and a rename', async () => {
    expect(await files.readText('stack', '.env')).toBeNull();
    await files.writeText('stack', 'a/b/.env', 'K=1\n', { mode: 0o600 });
    expect(fs.readFileSync(path.join(root, 'stack', 'a', 'b', '.env'), 'utf8')).toBe('K=1\n');
    expect(fs.statSync(path.join(root, 'stack', 'a', 'b', '.env')).mode & 0o777).toBe(0o600);
    expect(sftp.calls).toContain('rename');
    expect(fs.readdirSync(path.join(root, 'stack', 'a', 'b'))).toEqual(['.env']);
  });

  it('keeps an existing file’s mode', async () => {
    fs.writeFileSync(path.join(root, 'stack', 'x'), 'old', { mode: 0o644 });
    fs.chmodSync(path.join(root, 'stack', 'x'), 0o644);
    await files.writeText('stack', 'x', 'new', { mode: 0o600 });
    expect(fs.statSync(path.join(root, 'stack', 'x')).mode & 0o777).toBe(0o644);
    await files.writeBytes('stack', 'x', new Uint8Array([104, 105]));
    expect(fs.readFileSync(path.join(root, 'stack', 'x'), 'utf8')).toBe('hi');
  });

  it('keeps paths inside their location', async () => {
    await expect(files.readText('stack', '../escape')).rejects.toThrow(/outside stack/);
    await expect(files.readText('stack', '/etc/passwd')).rejects.toThrow(/must be relative/);
  });

  it('puts data under the stack folder and user content where ASSISTANT_DATA_ROOT says', async () => {
    await files.writeText('data', 'hermes/x', '1');
    await files.writeText('userContent', 'projects/y', '2');
    expect(fs.readFileSync(path.join(root, 'stack', 'data', 'hermes', 'x'), 'utf8')).toBe('1');
    expect(fs.readFileSync(path.join(content, 'projects', 'y'), 'utf8')).toBe('2');
  });

  it('stats, lists and checks for files', async () => {
    await files.writeText('stack', 'd/f', 'abc');
    expect(await files.stat('stack', 'd/f')).toEqual({ kind: 'file', size: 3 });
    expect(await files.stat('stack', 'd')).toEqual({ kind: 'folder', size: 0 });
    expect(await files.stat('stack', 'nope')).toBeNull();
    expect(await files.list('stack', 'd')).toEqual(['f']);
    expect(await files.list('stack', 'nope')).toBeNull();
    expect(await files.exists('stack', 'd/f')).toBe(true);
    expect(await files.exists('stack', 'd/g')).toBe(false);
  });

  it('resolves links relative to the location, and null outside it', async () => {
    await files.writeText('stack', 'real/f', 'x');
    fs.symlinkSync(path.join(root, 'stack', 'real'), path.join(root, 'stack', 'link'));
    fs.symlinkSync(root, path.join(root, 'stack', 'out'));
    expect(await files.realpath('stack', 'link/f')).toBe('real/f');
    expect(await files.realpath('stack', '')).toBe('');
    expect(await files.realpath('stack', 'out')).toBeNull();
    expect(await files.realpath('stack', 'missing')).toBeNull();
  });

  it('makes folders with a mode, renames and replaces a file', async () => {
    await files.mkdir('stack', 'p/q', { mode: 0o700 });
    expect(fs.statSync(path.join(root, 'stack', 'p', 'q')).mode & 0o777).toBe(0o700);
    await files.mkdir('stack', 'p/q');
    await files.writeText('stack', 'p/a', 'A');
    await files.writeText('stack', 'p/b', 'B');
    await files.rename('stack', 'p/a', 'p/b');
    expect(await files.readText('stack', 'p/b')).toBe('A');
    expect(await files.exists('stack', 'p/a')).toBe(false);
  });

  it('removes a tree without following links, and refuses the location itself', async () => {
    await files.writeText('stack', 'keep/f', 'x');
    await files.writeText('stack', 'gone/a/b', 'y');
    fs.symlinkSync(path.join(root, 'stack', 'keep'), path.join(root, 'stack', 'gone', 'link'));
    await files.remove('stack', 'gone');
    expect(fs.existsSync(path.join(root, 'stack', 'gone'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'stack', 'keep', 'f'), 'utf8')).toBe('x');
    await files.remove('stack', 'never-there');
    await expect(files.remove('stack', '')).rejects.toThrow(/Refusing/);
  });
});
