import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The real network entry under Node, with a fake parent port standing in for main and no DHT
 * bootstrap nodes, so nothing leaves the machine. It loads the same native addons the packaged
 * app does, from node_modules.
 */

type Posted = Record<string, unknown>;
const posted: Posted[] = [];
const postedEvents = new EventEmitter();
const parentPort = Object.assign(new EventEmitter(), {
  postMessage: (m: Posted) => {
    posted.push(m);
    postedEvents.emit('posted', m);
  },
});

/** Resolves when the process posts a message of one of `types`, or at once if it already has. */
const postedType = (...types: string[]) =>
  new Promise<void>((resolve) => {
    const matches = (m: Posted) => types.includes(m.type as string);
    if (posted.some(matches)) return resolve();
    const onPosted = (m: Posted) => {
      if (!matches(m)) return;
      postedEvents.off('posted', onPosted);
      resolve();
    };
    postedEvents.on('posted', onPosted);
  });

describe('circles network process', () => {
  const realExit = process.exit;
  let storageDir = '';

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-network-'));
    (process as unknown as { parentPort: unknown }).parentPort = parentPort;
    // Keep the process's own exit from ending the test worker.
    (process as unknown as { exit: unknown }).exit = () => undefined;
    await import('../networkProcess');
  });

  afterAll(async () => {
    // The process exits on the tick after it posts `stopped`; let that run against the stand-in.
    await new Promise((resolve) => setImmediate(resolve));
    process.exit = realExit;
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('loads every required native addon and reports it', async () => {
    parentPort.emit('message', { data: { type: 'start', storageDir, mode: { kind: 'load' }, bootstrap: [] } });
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
    parentPort.emit('message', {
      data: { type: 'shared-request', id: 9, key: 'c'.repeat(64), provider: 'a'.repeat(64), request: { method: 'POST', path: '/v1/chat/completions' } },
    });
    await postedType('shared-end');
    expect(posted.find((m) => m.type === 'shared-end')).toEqual({ type: 'shared-end', id: 9, error: 'Circles are not running.' });
    expect(posted.find((m) => m.type === 'shared-head')).toBeUndefined();
  });

  it('closes the swarm and store on stop', async () => {
    parentPort.emit('message', { data: { type: 'stop' } });
    await postedType('stopped');

    expect(posted.find((m) => m.type === 'log' && m.message === 'close failed')).toBeUndefined();
    expect(posted.at(-1)).toEqual({ type: 'stopped' });
  });
});
