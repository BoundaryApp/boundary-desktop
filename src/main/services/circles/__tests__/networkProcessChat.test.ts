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
  new Promise<Posted>((resolve) => {
    const found = posted.find(matches);
    if (found) return resolve(found);
    const onPosted = (m: Posted) => {
      if (!matches(m)) return;
      postedEvents.off('posted', onPosted);
      resolve(m);
    };
    postedEvents.on('posted', onPosted);
  });

let nextId = 1;
async function request(body: Record<string, unknown>): Promise<Posted> {
  const id = nextId++;
  parentPort.emit('message', { data: { type: 'circles-request', id, request: body } });
  return postedWhere((m) => m.type === 'circles-reply' && m.id === id);
}

describe('Circle chat in the network process', () => {
  const realExit = process.exit;
  let storageDir = '';
  let key = '';

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-chat-'));
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
    const created = await request({ op: 'create', name: 'Allotment' });
    key = (created.secrets as { key: string }).key;
  });

  afterAll(async () => {
    parentPort.emit('message', { data: { type: 'stop' } });
    await postedWhere((m) => m.type === 'stopped');
    await new Promise((resolve) => setImmediate(resolve));
    process.exit = realExit;
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('answers posts, reads and channels under `chat`, and sends the update', async () => {
    const reply = await request({ op: 'chat-post', key, channel: 'general', text: 'Hello' });
    const { id } = reply.chat as { id: string };
    expect(reply).toMatchObject({ ok: true, chat: { id: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    const update = await postedWhere((m) => m.type === 'chat-update');
    expect(update.update).toMatchObject({ channel: 'general', added: [{ id, text: 'Hello', mine: true, name: 'Ada' }] });

    const read = await request({ op: 'chat-messages', key, channel: 'general', limit: 10 });
    expect(read).toMatchObject({ ok: true, chat: { messages: [{ id, text: 'Hello' }], more: false } });
    const channels = await request({ op: 'chat-channels', key, reads: {} });
    expect(channels).toMatchObject({ ok: true, chat: { channels: [{ id: 'general', name: 'General', unread: 1 }] } });
    const edited = await request({ op: 'chat-edit', key, channel: 'general', id, text: 'Hi' });
    expect(edited).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true });
  });

  it('answers a refusal with its error', async () => {
    const reply = await request({ op: 'chat-post', key, channel: 'nowhere', text: 'Hello' });
    expect(reply).toMatchObject({ ok: false, error: 'That channel isn’t in this Circle.' });
  });
});
