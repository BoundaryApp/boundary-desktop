import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({ opens: true }));
vi.mock('../../secrets/osEncryption', () => ({
  encryptToBase64: async (value: string) => Buffer.from(`sealed:${value}`).toString('base64'),
  tryDecryptFromBase64: async (value: string) => {
    if (!keychain.opens) return null;
    const text = Buffer.from(value, 'base64').toString();
    return text.startsWith('sealed:') ? text.slice('sealed:'.length) : null;
  },
}));

import { directStore } from '../directStore';
import type { DirectFile } from '../directMessages';

const KEY = 'cc'.repeat(32);
const file: DirectFile = {
  version: 1,
  conversations: { ['bb'.repeat(32)]: { peer: 'bb'.repeat(32), name: 'Maya', ended: false, messages: [] } },
  outbox: [],
};

describe('direct message store', () => {
  let dir: string;
  beforeEach(async () => {
    keychain.opens = true;
    dir = path.join(await mkdtemp(path.join(tmpdir(), 'boundary-dm-')), 'direct');
  });
  afterEach(async () => rm(path.dirname(dir), { recursive: true, force: true }));

  it('keeps each Circle in its own sealed file and lists it', async () => {
    const store = directStore(dir);
    expect(await store.keys()).toEqual([]);
    expect(await store.load(KEY)).toBeNull();
    await store.save(KEY, file);
    expect(await store.keys()).toEqual([KEY]);
    expect(await store.load(KEY)).toEqual(file);
    const raw = await readFile(path.join(dir, `${KEY}.dm`), 'utf8');
    expect(raw).not.toContain('Maya');
    expect(await readdir(dir)).toEqual([`${KEY}.dm`]);
  });

  it('removes a Circle’s file', async () => {
    const store = directStore(dir);
    await store.save(KEY, file);
    await store.remove(KEY);
    expect(await store.keys()).toEqual([]);
    await store.remove(KEY);
  });

  it('refuses a key that isn’t a Circle key', async () => {
    const store = directStore(dir);
    await expect(store.save('../escape', file)).rejects.toThrow('Circle key');
  });

  it('throws rather than start empty when the keychain won’t open a file, and leaves it alone', async () => {
    const store = directStore(dir);
    await store.save(KEY, file);
    keychain.opens = false;
    await expect(store.load(KEY)).rejects.toThrow('keychain');
    keychain.opens = true;
    expect(await store.load(KEY)).toEqual(file);
  });

  it('throws rather than call a file it can’t read empty', async () => {
    const store = directStore(dir);
    await store.save(KEY, file);
    await chmod(path.join(dir, `${KEY}.dm`), 0o000);
    await expect(store.load(KEY)).rejects.toThrow();
    await chmod(path.join(dir, `${KEY}.dm`), 0o600);
  });

  it('ignores files that aren’t a Circle’s', async () => {
    const store = directStore(dir);
    await store.save(KEY, file);
    await writeFile(path.join(dir, 'notes.txt'), 'x');
    await writeFile(path.join(dir, `${KEY}.dm.123.tmp`), 'x');
    expect(await store.keys()).toEqual([KEY]);
  });
});
