import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoreFromMemory } from '../storeMemoryCache';

interface Shape {
  sessionMeta: Record<string, { agentSlug: string }>;
  channels: string[];
  note?: string;
}

describe('readStoreFromMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-memory-cache-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const open = (): Conf<Shape> =>
    readStoreFromMemory(
      new Conf<Shape>({
        cwd: dir,
        projectName: 'test',
        configName: 'agents',
        defaults: { sessionMeta: {}, channels: [] },
      })
    );

  it('reads the file once after a write, however many gets follow', () => {
    const store = open();
    store.set('sessionMeta', { s1: { agentSlug: 'assistant' } });
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 500; i++) {
      expect(store.get('sessionMeta').s1.agentSlug).toBe('assistant');
      expect(store.has('channels')).toBe(true);
    }
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('writes every set through to disk and reads it back', () => {
    const store = open();
    store.set('channels', ['a']);
    store.set('channels', ['a', 'b']);
    store.set('note', 'gone');
    store.delete('note');
    expect(store.get('channels')).toEqual(['a', 'b']);
    expect(store.has('note')).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(store.path, 'utf8'));
    expect(onDisk.channels).toEqual(['a', 'b']);
    expect(onDisk).not.toHaveProperty('note');
    // A fresh instance (the next app start) sees the same records.
    expect(open().get('channels')).toEqual(['a', 'b']);
  });

  it('reads what set and delete wrote, through get and store', () => {
    const store = open();
    expect(store.get('channels')).toEqual([]);
    store.set('channels', ['a']);
    expect(store.get('channels')).toEqual(['a']);
    expect(store.store.channels).toEqual(['a']);
    store.set('note', 'x');
    expect(store.get('note')).toBe('x');
    store.delete('note');
    expect(store.has('note')).toBe(false);
    store.store = { sessionMeta: {}, channels: ['b'] };
    expect(store.get('channels')).toEqual(['b']);
  });

  it('keeps the previous contents when a write fails', () => {
    const store = open();
    store.set('channels', ['kept']);
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => store.set('channels', ['lost'])).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(store.get('channels')).toEqual(['kept']);
  });
});
