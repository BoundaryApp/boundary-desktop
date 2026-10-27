import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPath, isPathUnder, samePath } from '../hostPaths';

describe('isPathUnder', () => {
  it('accepts the root itself and paths inside it', () => {
    expect(isPathUnder('/a/b', '/a/b')).toBe(true);
    expect(isPathUnder('/a/b/c', '/a/b')).toBe(true);
    expect(isPathUnder('/a/b/c', '/a/b/')).toBe(true);
    expect(isPathUnder('/a/b/../b/c', '/a/b')).toBe(true);
  });

  it('rejects siblings that share a prefix and paths that leave the root', () => {
    expect(isPathUnder('/a/bc', '/a/b')).toBe(false);
    expect(isPathUnder('/a/b/../c', '/a/b')).toBe(false);
  });

  it('treats everything as under /', () => {
    expect(isPathUnder('/a', '/')).toBe(true);
  });
});

describe('samePath', () => {
  it('compares resolved paths', () => {
    expect(samePath('/a/b/', '/a/b')).toBe(true);
    expect(samePath('/a/b', '/a/c')).toBe(false);
  });
});

describe('canonicalPath', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('follows symlinks and resolves a missing path', () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-paths-')));
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    expect(canonicalPath(link)).toBe(real);
    expect(canonicalPath(path.join(dir, 'missing', '..', 'gone'))).toBe(path.join(dir, 'gone'));
  });
});
