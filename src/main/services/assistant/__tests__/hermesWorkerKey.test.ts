import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHermesWorkerKey, hermesWorkerKeyPath } from '../hermesWorkerKey';

let root: string;

/** Stands in for ssh-keygen: writes both halves at the -f path. */
const fakeKeygen = vi.fn(async (args: string[]) => {
  const key = args[args.indexOf('-f') + 1];
  fs.writeFileSync(key, 'private');
  fs.writeFileSync(`${key}.pub`, 'ssh-ed25519 AAAA hermes-worker');
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-key-'));
  fakeKeygen.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ensureHermesWorkerKey', () => {
  it('keeps an existing key pair', async () => {
    const key = hermesWorkerKeyPath(root);
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, 'mine');
    fs.writeFileSync(`${key}.pub`, 'mine.pub');

    expect(await ensureHermesWorkerKey(root, fakeKeygen)).toBe(false);
    expect(fakeKeygen).not.toHaveBeenCalled();
    expect(fs.readFileSync(key, 'utf8')).toBe('mine');
  });

  it('makes a pair with private-key permissions when none exists', async () => {
    expect(await ensureHermesWorkerKey(root, fakeKeygen)).toBe(true);
    const key = hermesWorkerKeyPath(root);
    expect(fakeKeygen).toHaveBeenCalledWith([
      '-t',
      'ed25519',
      '-f',
      key,
      '-N',
      '',
      '-C',
      'hermes-worker',
    ]);
    expect(fs.statSync(key).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${key}.pub`).mode & 0o777).toBe(0o644);
  });

  it('replaces a pair with a missing half', async () => {
    const key = hermesWorkerKeyPath(root);
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(key, 'orphan');

    expect(await ensureHermesWorkerKey(root, fakeKeygen)).toBe(true);
    expect(fs.readFileSync(key, 'utf8')).toBe('private');
  });
});
