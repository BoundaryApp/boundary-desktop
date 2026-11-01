import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeLegacyUpdateFiles } from '../legacyUpdateFiles';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

describe('removeLegacyUpdateFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'legacy-update-files-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const folder = async (name: string, ageHours: number) => {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(join(path, 'update.zip'), 'zip');
    const time = new Date(NOW - ageHours * HOUR_MS);
    await utimes(path, time, time);
    return path;
  };

  it('removes an old download folder, with its partial zip', async () => {
    const path = await folder('boundary-update-abc123', 25);
    expect(await removeLegacyUpdateFiles(dir, NOW)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves a recent folder, which may be an older instance still downloading', async () => {
    const path = await folder('boundary-update-abc123', 23);
    expect(await removeLegacyUpdateFiles(dir, NOW)).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it('leaves other folders and files, and does not follow a link', async () => {
    const other = await folder('boundary-other', 100);
    const target = await folder('target', 100);
    const file = join(dir, 'boundary-update-file');
    await writeFile(file, 'x');
    await symlink(target, join(dir, 'boundary-update-link'));
    expect(await removeLegacyUpdateFiles(dir, NOW)).toBe(0);
    expect([other, target, file].every(existsSync)).toBe(true);
  });
});
