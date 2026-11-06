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
  getReadPositions,
  hasCircles,
  listCircleSecrets,
  listInviteCodeIds,
  markCircleLeaving,
  pruneInviteCodes,
  readInviteCode,
  saveCircleSecrets,
  saveInviteCode,
  setReadPosition,
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

describe('a Circle this user left', () => {
  const sealed = (value: object) => `sealed:${[...JSON.stringify(value)].reverse().join('')}`;
  /** The fake store keeps `circles.<key>` writes as their own keys; fold them into `circles`. */
  const fold = () => {
    const circles = { ...(data.get('circles') as Record<string, string>) };
    for (const [name, value] of data) {
      if (!name.startsWith('circles.')) continue;
      circles[name.slice(8)] = value as string;
      data.delete(name);
    }
    data.set('circles', circles);
  };

  beforeEach(() => {
    data.clear();
    keychain.available = true;
    data.set('circles', {
      aa: sealed({ namespace: 'n1', key: 'aa', encryptionKey: 'e1' }),
      bb: sealed({ namespace: 'n2', key: 'bb', encryptionKey: 'e2' }),
    });
  });

  it('keeps its secrets, marked as leaving, and drops what only this device used', async () => {
    await saveInviteCode('aa', 'i1', 'c', Date.now() + 60_000);
    setReadPosition('aa', 'general', { author: 'a1', id: 'm1', at: 1 });
    markCircleLeaving('aa');
    const secrets = await listCircleSecrets();
    expect(secrets).toEqual([
      { namespace: 'n1', key: 'aa', encryptionKey: 'e1', leaving: true },
      { namespace: 'n2', key: 'bb', encryptionKey: 'e2' },
    ]);
    expect(JSON.stringify(data.get('circles'))).not.toContain('leaving');
    expect(listInviteCodeIds('aa')).toEqual([]);
    expect(getReadPositions('aa')).toEqual({});
  });

  it('forgets the mark with the Circle, and when it is joined again', async () => {
    markCircleLeaving('aa');
    markCircleLeaving('bb');
    forgetCircle('aa');
    await saveCircleSecrets({ namespace: 'n3', key: 'bb', encryptionKey: 'e2', leaving: true });
    fold();
    expect(await listCircleSecrets()).toEqual([{ namespace: 'n3', key: 'bb', encryptionKey: 'e2' }]);
    expect(data.get('leavingCircles')).toEqual([]);
  });

  it('marks nothing for a Circle it doesn’t have', () => {
    markCircleLeaving('cc');
    expect(data.get('leavingCircles')).toBeUndefined();
  });
});

describe('read positions', () => {
  beforeEach(() => data.clear());

  it('keeps one per channel, and forgets a Circle’s when it goes', () => {
    setReadPosition('aa', 'general', { author: 'a1', id: 'm1', at: 1 });
    setReadPosition('aa', 'general', { author: 'a1', id: 'm2', at: 2 });
    setReadPosition('aa', 'garden', { author: 'a2', id: 'm3', at: 3 });
    setReadPosition('bb', 'general', { author: 'a1', id: 'm4', at: 4 });
    expect(getReadPositions('aa')).toEqual({
      general: { author: 'a1', id: 'm2', at: 2 },
      garden: { author: 'a2', id: 'm3', at: 3 },
    });
    forgetCircle('aa');
    expect(getReadPositions('aa')).toEqual({});
    expect(getReadPositions('bb').general?.id).toBe('m4');
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
