import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { networkProcessHarness, type Posted } from './networkProcessHarness';

/**
 * The real network entry running Circles as Ada with no bootstrap nodes, as networkProcess.test.ts
 * does. Both describes share one started process and one Circle.
 */

const { posted, send, postedWhere, postedType, load, restore } = networkProcessHarness();

let nextId = 1;
async function request(body: Record<string, unknown>): Promise<Posted> {
  const id = nextId++;
  send({ type: 'circles-request', id, request: body });
  return postedWhere(`circles-reply to request ${id} (${String(body.op)})`, (m) => m.type === 'circles-reply' && m.id === id);
}

let storageDir = '';
let key = '';

beforeAll(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circles-chat-'));
  await load();
  send({
    type: 'circles-start',
    storageDir,
    identitySeed: 'a'.repeat(64),
    deviceSeed: 'b'.repeat(64),
    name: 'Ada',
    circles: [],
    bootstrap: [],
  });
  await postedType('circles-ready');
  const created = await request({ op: 'create', name: 'Allotment' });
  expect(Object.keys(created).sort()).toEqual(['id', 'ok', 'secrets', 'type']);
  key = (created.secrets as { key: string }).key;
});

afterAll(async () => {
  send({ type: 'stop' });
  await postedType('stopped');
  await restore();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('circles-reply fields', () => {
  it('names each result by its field: secrets, invite, records, or none', async () => {
    const created = await request({ op: 'create', name: 'Orchard' });
    expect(Object.keys(created).sort()).toEqual(['id', 'ok', 'secrets', 'type']);
    const orchard = (created.secrets as { key: string }).key;
    const invite = await request({ op: 'invite', key: orchard, expiresAt: Date.now() + 60_000 });
    expect(invite).toMatchObject({ ok: true, invite: { id: expect.any(String), code: expect.any(String), expires: expect.any(Number) } });
    expect(invite).not.toHaveProperty('secrets');
    const set = await request({ op: 'record-set', key: orchard, app: 'test', scope: 'circle', record: 'r1', value: { n: 1 } });
    expect(set).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true });
    const records = await request({ op: 'records-list', key: orchard, app: 'test' });
    expect(records).toMatchObject({ ok: true, records: [{ app: 'test', key: 'r1' }] });
    const empty = await request({ op: 'records-list', key: orchard, app: 'none' });
    expect(empty).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true, records: [] });
  });
});

describe('Circle chat in the network process', () => {
  it('answers posts, reads and channels under `chat`, and sends the update', async () => {
    const reply = await request({ op: 'chat-post', key, channel: 'general', text: 'Hello' });
    const { id } = reply.chat as { id: string };
    expect(reply).toMatchObject({ ok: true, chat: { id: expect.stringMatching(/^[0-9a-f]{32}$/) } });
    const update = await postedType('chat-update');
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

  it('routes chat-react to reactMessage with its fields', async () => {
    const { id } = (await request({ op: 'chat-post', key, channel: 'general', text: 'React to me' })).chat as { id: string };
    const read = await request({ op: 'chat-messages', key, channel: 'general', limit: 50 });
    const messages = (read.chat as { messages: { id: string; author: string }[] }).messages;
    const { author } = messages.find((m) => m.id === id)!;
    const on = await request({ op: 'chat-react', key, channel: 'general', author, id, emoji: '👍', on: true });
    expect(on).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true });
    const after = await request({ op: 'chat-messages', key, channel: 'general', limit: 50 });
    const shown = (after.chat as { messages: { id: string; reactions: unknown[] }[] }).messages;
    expect(shown.find((m) => m.id === id)?.reactions).toMatchObject([{ emoji: '👍', count: 1, mine: true }]);
    const bad = await request({ op: 'chat-react', key, channel: 'general', author, id, emoji: 'x', on: true });
    expect(bad).toMatchObject({ ok: false, error: 'That isn’t an emoji.' });
  });

  it('refuses mentions on a post or edit in a Circle below format 3', async () => {
    const mentions = { channel: true };
    const post = await request({ op: 'chat-post', key, channel: 'general', text: 'Hi @channel', mentions });
    expect(post).toMatchObject({ ok: false, error: 'Mentions need this Circle updated.' });
    const { id } = (await request({ op: 'chat-post', key, channel: 'general', text: 'Plain' })).chat as { id: string };
    const edit = await request({ op: 'chat-edit', key, channel: 'general', id, text: 'Hi @channel', mentions });
    expect(edit).toMatchObject({ ok: false, error: 'Mentions need this Circle updated.' });
  });
});

describe('replies in the network process', () => {
  it('refuses a reply below format 3', async () => {
    const reply = { author: 'a'.repeat(64), id: 'b'.repeat(32) };
    const post = await request({ op: 'chat-post', key, channel: 'general', text: 'Yes', reply });
    expect(post).toMatchObject({ ok: false, error: 'Replies need this Circle to be updated first.' });
  });

  it('answers chat-message with the message, or null when it isn’t there', async () => {
    const { id } = (await request({ op: 'chat-post', key, channel: 'general', text: 'Find me' })).chat as { id: string };
    const read = await request({ op: 'chat-messages', key, channel: 'general', limit: 50 });
    const { author } = (read.chat as { messages: { id: string; author: string }[] }).messages.find((m) => m.id === id)!;
    const found = await request({ op: 'chat-message', key, channel: 'general', ref: { author, id } });
    expect(found).toMatchObject({ ok: true, chat: { message: { id, text: 'Find me', reply: null } } });
    const none = await request({ op: 'chat-message', key, channel: 'general', ref: { author, id: 'c'.repeat(32) } });
    expect(none).toMatchObject({ ok: true, chat: { message: null } });
  });
});

describe('circles-reply fields', () => {
  it('puts each result under its own field, and nothing for a request with no result', async () => {
    const invite = await request({ op: 'invite', key, expiresAt: Date.now() + 60_000 });
    expect(Object.keys(invite).sort()).toEqual(['id', 'invite', 'ok', 'type']);
    expect(invite.invite).toMatchObject({ id: expect.any(String), code: expect.any(String), expires: expect.any(Number) });

    const records = await request({ op: 'records-list', key, app: 'notes' });
    expect(records).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true, records: [] });

    const address = await request({ op: 'public-address' });
    expect(Object.keys(address).sort()).toEqual(['address', 'id', 'ok', 'type']);

    const renamed = await request({ op: 'set-name', name: 'Ada L.' });
    expect(renamed).toEqual({ type: 'circles-reply', id: expect.any(Number), ok: true });
  });
});

describe('peer signals in the network process', () => {
  it('logs a signal it can’t send and keeps running', async () => {
    send({ type: 'signal-topics', topics: ['typing'] });
    send({ type: 'signal-send', key: 'c'.repeat(64), topic: 'typing', payload: 'private text' });
    await postedWhere('signal not sent log', (m) => m.type === 'log' && m.message === 'signal not sent');
    expect(posted.find((m) => m.message === 'signal not sent')).toEqual({
      type: 'log',
      message: 'signal not sent',
      data: { error: 'Not a member of that Circle.' },
    });
    expect(JSON.stringify(posted)).not.toContain('private text');
  });
});
