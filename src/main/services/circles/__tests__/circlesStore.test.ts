import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => new Map<string, unknown>());
const remove = vi.hoisted(() => ({ fail: false }));

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
vi.mock('../../secrets/osEncryption', () => ({}));

import { getCircleSharing, hasCircles, wipeOutdatedCircles } from '../circlesStore';

const SHARING = { models: [{ id: 'm', tools: true }], circles: ['aa'], paused: true, away: false };

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

  it('is harmless on a new install', () => {
    rmSync(storageDir, { recursive: true });
    data.delete('sharing');
    data.set('circles', {});
    expect(() => wipeOutdatedCircles(storageDir)).not.toThrow();
  });
});
