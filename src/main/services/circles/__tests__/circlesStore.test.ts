import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => new Map<string, unknown>());
const remove = vi.hoisted(() => ({ fail: false }));
const keychain = vi.hoisted(() => ({ available: true, rotate: false }));

vi.mock('electron-store', () => ({
  default: class {
    get = (key: string) => data.get(key);
    set = (key: string, value: unknown) => void data.set(key, value);
  },
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (remove.fail) throw new Error('busy');
      fs.rmSync(...args);
    },
  };
});
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: () => undefined }));
vi.mock('../../secrets/osEncryption', () => ({
  isOsEncryptionAvailable: async () => keychain.available,
  encryptToBase64: async (value: string) => `sealed:${[...value].reverse().join('')}`,
  tryDecryptFromBase64: async (value: string, onReEncrypted?: (next: string) => void) => {
    if (keychain.rotate) onReEncrypted?.(value);
    return value.startsWith('sealed:') ? [...value.slice(7)].reverse().join('') : null;
  },
}));

import {
  circlesKeptByWipe,
  forgetCircle,
  forgetInviteCode,
  getCircleSharing,
  getInviteCodeIds,
  hasCircles,
  listInviteCodeIds,
  pruneInviteCodes,
  readInviteCode,
  saveInviteCode,
  wipeOutdatedCircles,
} from '../circlesStore';

const SHARING = { models: [{ id: 'm', tools: true }], circles: ['aa'], paused: true, away: false };

describe('invite codes', () => {
  const later = Date.now() + 60_000;
  const view = (key: string, invites: Array<{ id: string; used?: boolean; revoked?: boolean }>) => ({
    key,
    name: '',
    myRole: 'admin' as const,
    members: [],
    offers: [],
    needsUpdate: false, writable: true,
    invites: invites.map((invite) => ({ used: false, revoked: false, expires: later, ...invite })),
  });

  beforeEach(() => {
    data.clear();
    data.set('circles', { aa: 'sealed', bb: 'sealed' });
    keychain.available = true;
    keychain.rotate = false;
  });

  it('stores a code encrypted and reads it back', async () => {
    await saveInviteCode('aa', 'i1', 'yrb7ei1ngcode', later);
    expect(JSON.stringify(data.get('inviteCodes'))).not.toContain('yrb7ei1ng');
    expect(data.get('inviteLabels')).toBeUndefined();
    await expect(readInviteCode('aa', 'i1')).resolves.toBe('yrb7ei1ngcode');
    await expect(readInviteCode('aa', 'i2')).resolves.toBeNull();
    expect(listInviteCodeIds('aa')).toEqual(['i1']);
  });

  it('refuses to store a code without the keychain', async () => {
    keychain.available = false;
    await expect(saveInviteCode('aa', 'i1', 'code', later)).rejects.toThrow('keychain');
    expect(getInviteCodeIds()).toEqual([]);
  });

  it('stores the new ciphertext when the key rotated', async () => {
    await saveInviteCode('aa', 'i1', 'code', later);
    keychain.rotate = true;
    await expect(readInviteCode('aa', 'i1')).resolves.toBe('code');
    expect(listInviteCodeIds('aa')).toEqual(['i1']);
  });

  it('prunes used, revoked and expired invites, and keeps one the view hasn’t shown yet', async () => {
    await saveInviteCode('aa', 'used', 'c', later);
    await saveInviteCode('aa', 'revoked', 'c', later);
    await saveInviteCode('aa', 'expired', 'c', Date.now() - 1);
    await saveInviteCode('aa', 'open', 'c', later);
    await saveInviteCode('aa', 'unseen', 'c', later);
    const kept = pruneInviteCodes([view('aa', [{ id: 'used', used: true }, { id: 'revoked', revoked: true }, { id: 'open' }])]);
    expect(kept.sort()).toEqual(['open', 'unseen']);
    expect(getInviteCodeIds().sort()).toEqual(['open', 'unseen']);
  });

  it('forgets one code, and every code of a Circle that goes', async () => {
    await saveInviteCode('aa', 'i1', 'c', later);
    await saveInviteCode('aa', 'i2', 'c', later);
    await saveInviteCode('bb', 'i3', 'c', later);
    forgetInviteCode('aa', 'i1');
    expect(listInviteCodeIds('aa')).toEqual(['i2']);
    forgetCircle('aa');
    expect(getInviteCodeIds()).toEqual(['i3']);
  });
});

describe('wipeOutdatedCircles', () => {
  let dir: string;
  let storageDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'circles-store-'));
    storageDir = path.join(dir, 'circles');
    mkdirSync(path.join(storageDir, 'corestore'), { recursive: true });
    writeFileSync(path.join(storageDir, 'removed-devices.json'), '{}');
    data.clear();
    data.set('circles', { aa: 'sealed' });
    data.set('seeds', 'sealed-seeds');
    data.set('displayName', 'Ada');
    data.set('providers', { bb: { private: true, trusted: false } });
    data.set('sharing', SHARING);
    data.set('inviteCodes', { aa: { i1: { code: 'sealed', expires: 1 } } });
    remove.fail = false;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes Circles and their blocks, and keeps what is not tied to a Circle', () => {
    wipeOutdatedCircles(storageDir);
    expect(existsSync(storageDir)).toBe(false);
    expect(hasCircles()).toBe(false);
    expect(getCircleSharing()).toEqual({ ...SHARING, circles: [] });
    expect(data.get('seeds')).toBe('sealed-seeds');
    expect(data.get('displayName')).toBe('Ada');
    expect(data.get('providers')).toEqual({ bb: { private: true, trusted: false } });
    expect(getInviteCodeIds()).toEqual([]);
  });

  it('runs once', () => {
    wipeOutdatedCircles(storageDir);
    data.set('circles', { cc: 'sealed' });
    mkdirSync(storageDir);
    wipeOutdatedCircles(storageDir);
    expect(hasCircles()).toBe(true);
    expect(existsSync(storageDir)).toBe(true);
  });

  it('tries again next time when the delete fails', () => {
    remove.fail = true;
    expect(() => wipeOutdatedCircles(storageDir)).toThrow('busy');
    expect(hasCircles()).toBe(true);
    remove.fail = false;
    wipeOutdatedCircles(storageDir);
    expect(hasCircles()).toBe(false);
  });

  it('counts no Circle as kept until the wipe has run, then the ones on this device', () => {
    expect(circlesKeptByWipe()).toEqual(new Set());
    wipeOutdatedCircles(storageDir);
    data.set('circles', { cc: 'sealed' });
    expect(circlesKeptByWipe()).toEqual(new Set(['cc']));
  });

  it('is harmless on a new install', () => {
    rmSync(storageDir, { recursive: true });
    data.delete('sharing');
    data.set('circles', {});
    expect(() => wipeOutdatedCircles(storageDir)).not.toThrow();
  });
});
