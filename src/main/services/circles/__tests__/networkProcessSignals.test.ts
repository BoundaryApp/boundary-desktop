import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The real network entry running Circles with no bootstrap nodes, as networkProcess.test.ts does. */

type Posted = Record<string, unknown>;
const posted: Posted[] = [];
const postedEvents = new EventEmitter();
const parentPort = Object.assign(new EventEmitter(), {
  postMessage: (m: Posted) => {
    posted.push(m);
    postedEvents.emit('posted', m);
  },
});

const postedWhere = (matches: (m: Posted) => boolean) =>
  new Promise<void>((resolve) => {
    if (posted.some(matches)) return resolve();
    const onPosted = (m: Posted) => {
      if (!matches(m)) return;
      postedEvents.off('posted', onPosted);
      resolve();
    };
    postedEvents.on('posted', onPosted);
  });

describe('peer signals in the network process', () => {
  const realExit = process.exit;
  let storageDir = '';

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-signals-'));
    (process as unknown as { parentPort: unknown }).parentPort = parentPort;
    (process as unknown as { exit: unknown }).exit = () => undefined;
    await import('../networkProcess');
    parentPort.emit('message', {
      data: {
        type: 'circles-start',
        storageDir,
        identitySeed: 'a'.repeat(64),
        deviceSeed: 'b'.repeat(64),
        name: 'Ada',
        circles: [],
        bootstrap: [],
      },
    });
    await postedWhere((m) => m.type === 'circles-ready');
  });

  afterAll(async () => {
    parentPort.emit('message', { data: { type: 'stop' } });
    await postedWhere((m) => m.type === 'stopped');
    await new Promise((resolve) => setImmediate(resolve));
    process.exit = realExit;
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('logs a signal it can’t send and keeps running', async () => {
    parentPort.emit('message', { data: { type: 'signal-topics', topics: ['typing'] } });
    parentPort.emit('message', { data: { type: 'signal-send', key: 'c'.repeat(64), topic: 'typing', payload: 'private text' } });
    await postedWhere((m) => m.type === 'log' && m.message === 'signal not sent');
    expect(posted.find((m) => m.message === 'signal not sent')).toEqual({
      type: 'log',
      message: 'signal not sent',
      data: { error: 'Not a member of that Circle.' },
    });
    expect(JSON.stringify(posted)).not.toContain('private text');
  });
});
