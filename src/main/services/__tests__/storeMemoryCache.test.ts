import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoreFromMemory } from '../storeMemoryCache';

interface Shape {
  sessionMeta: Record<string, { agentSlug: string }>;
  channels: string[];
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

  it('reads the file once, however many gets follow', () => {
    const store = open();
    store.set('sessionMeta', { s1: { agentSlug: 'assistant' } });
    const reads = vi.spyOn(fs, 'readFileSync');
    for (let i = 0; i < 500; i++) {
      expect(store.get('sessionMeta').s1.agentSlug).toBe('assistant');
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it('writes every set through to disk and reads it back', () => {
    const store = open();
    store.set('channels', ['a']);
    store.set('channels', ['a', 'b']);
    store.delete('sessionMeta');
    expect(store.get('channels')).toEqual(['a', 'b']);
    expect(store.has('sessionMeta')).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(store.path, 'utf8'));
    expect(onDisk.channels).toEqual(['a', 'b']);
    expect(onDisk).not.toHaveProperty('sessionMeta');
    // A fresh instance (the next app start) sees the same records.
    expect(open().get('channels')).toEqual(['a', 'b']);
  });

  it('keeps the previous contents when a write fails', () => {
    const store = open();
    store.set('channels', ['kept']);
    // conf writes through its own atomic writer; fail at its write step.
    vi.spyOn(store as unknown as { _write: (v: unknown) => void }, '_write').mockImplementation(
      () => {
        throw new Error('disk full');
      }
    );
    expect(() => store.set('channels', ['lost'])).toThrow();
    expect(store.get('channels')).toEqual(['kept']);
  });
});
