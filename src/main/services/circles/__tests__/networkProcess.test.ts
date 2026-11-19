import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { networkProcessHarness } from './networkProcessHarness';

/**
 * The real network entry under Node, with a fake parent port standing in for main and no DHT
 * bootstrap nodes, so nothing leaves the machine. It loads the same native addons the packaged
 * app does, from node_modules.
 */

const { posted, send, postedType, load, restore } = networkProcessHarness();

describe('circles network process', () => {
  let storageDir = '';

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-network-'));
    await load();
  });

  afterAll(async () => {
    // The process exits on the tick after it posts `stopped`; let that run against the stand-in.
    await restore();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('loads every required native addon and reports it', async () => {
    send({ type: 'start', storageDir, mode: { kind: 'load' }, bootstrap: [] });
    await postedType('addons', 'start-failed');

    expect(posted.find((m) => m.type === 'start-failed')).toBeUndefined();
    const addons = posted.find((m) => m.type === 'addons') as { loaded: string[]; missing: string[] };
    expect(addons.missing).toEqual([]);
    expect(addons.loaded).toEqual(expect.arrayContaining(['sodium-native', 'udx-native', 'rocksdb-native']));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'log', message: 'autobase ready', data: { writable: true, isIndexer: true } })
    );
  });

  it('answers a shared-model request with an error while Circles aren’t running', async () => {
    send({
      type: 'shared-request',
      id: 9,
      key: 'c'.repeat(64),
      provider: 'a'.repeat(64),
      request: { method: 'POST', path: '/v1/chat/completions' },
    });
    await postedType('shared-end');
    expect(posted.find((m) => m.type === 'shared-end')).toEqual({ type: 'shared-end', id: 9, error: 'Circles are not running.' });
    expect(posted.find((m) => m.type === 'shared-head')).toBeUndefined();
  });

  it('closes the swarm and store on stop', async () => {
    send({ type: 'stop' });
    await postedType('stopped');

    expect(posted.find((m) => m.type === 'log' && m.message === 'close failed')).toBeUndefined();
    expect(posted.at(-1)).toEqual({ type: 'stopped' });
  });
});
