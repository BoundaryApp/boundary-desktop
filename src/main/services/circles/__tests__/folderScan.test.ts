import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '../folderOps';
import { scanFolder } from '../folderScan';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'boundary-folder-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanning a folder before sharing it', () => {
  it('counts what members download and lists what stays on this Mac, with why', async () => {
    await mkdir(path.join(root, 'covers'));
    await writeFile(path.join(root, 'brief.md'), 'abc');
    await writeFile(path.join(root, 'covers', 'one.png'), '12345');
    await writeFile(path.join(root, '.env'), 'SECRET=1');
    await writeFile(path.join(root, '.env.example'), 'A=');
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'x', 'i.js'), '1');
    await symlink(path.join(root, 'brief.md'), path.join(root, 'link.md'));
    await writeFile(path.join(root, 'big.mov'), '');
    await truncate(path.join(root, 'big.mov'), MAX_FILE_BYTES + 1);

    const scan = await scanFolder(root);
    expect(scan).toMatchObject({ files: 3, bytes: 3 + 5 + 2, unsharedCount: 4, partial: false });
    expect(scan.unshared).toEqual([
      { path: '.env', reason: 'never-shared' },
      { path: 'big.mov', reason: 'too-large' },
      { path: 'link.md', reason: 'link' },
      { path: 'node_modules/', reason: 'never-shared' },
    ]);
  });

  it('stops at its limits and says the numbers are partial', async () => {
    for (const name of ['a', 'b', 'c', '.env', '.env.local']) await writeFile(path.join(root, name), 'x');
    const scan = await scanFolder(root, { entries: 4, unshared: 1 });
    expect(scan.partial).toBe(true);
    expect(scan.unshared).toHaveLength(1);
    expect(scan.unsharedCount).toBe(2);
    expect(scan.files).toBe(2);
  });

  it('reads an empty or missing folder as nothing to send', async () => {
    expect(await scanFolder(path.join(root, 'missing'))).toEqual({ files: 0, bytes: 0, unshared: [], unsharedCount: 0, partial: false });
  });
});
