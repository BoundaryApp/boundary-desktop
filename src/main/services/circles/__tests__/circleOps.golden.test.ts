import { describe, expect, it } from 'vitest';
import { applyCircleNodes, type CircleHost, type CircleMemberIntro, type CircleOp, type CircleView } from '../circleOps';

/**
 * Pins what each format does. Anyone joining replays the whole log, so if one fails, every peer on
 * an older build disagrees with this one. Don't update a file to make it pass: put the change
 * behind a new format (ADR 0038) and add a log for that format here.
 */

const hex = (char: string, length = 64) => char.repeat(length);

function intro(char: string, writer: string, device: string, name: string): CircleMemberIntro {
  return { identity: hex(char), name, writer: hex(writer), device: hex(device), signature: hex(char, 128) };
}

const ada = intro('a', 'b', 'c', 'Ada');
const bo = intro('1', '2', '3', 'Bo');
const cy = intro('4', '5', '6', 'Cy');
const inviteOp = (id: string): CircleOp => ({ type: 'invite', invite: { id: hex(id), publicKey: hex('e'), expires: 5 } });
const offer = { models: [{ id: 'small', contextLength: 4096, tools: true }], available: true, away: false };
const record = { app: 'profile', scope: 'member', key: 'bio' } as const;

const LOG: Array<[CircleMemberIntro, CircleOp]> = [
  [bo, { type: 'create', name: 'Not theirs', format: 1, member: ada }],
  [ada, { type: 'create', name: ' Garden club ', format: 1, member: ada }],
  [ada, inviteOp('7')],
  [ada, inviteOp('8')],
  [ada, inviteOp('9')],
  [ada, { type: 'add-member', member: bo, invite: hex('7') }],
  [ada, { type: 'add-member', member: cy, invite: hex('7') }],
  [ada, { type: 'add-member', member: cy, invite: hex('8') }],
  [bo, inviteOp('0')],
  [ada, { type: 'revoke-invite', id: hex('9') }],
  [bo, { type: 'offer', offer }],
  [cy, { type: 'offer', offer: { models: [{ id: '', tools: true }], available: true, away: false } }],
  [cy, { type: 'offer', offer }],
  [cy, { type: 'withdraw-offer' }],
  [bo, { type: 'record-set', ...record, value: { text: 'Beans' } }],
  [cy, { type: 'record-set', ...record, value: 'Peas' }],
  [cy, { type: 'record-set', app: 'other', scope: 'member', key: 'x', value: [1, 2] }],
  [cy, { type: 'record-set', app: 'settings', scope: 'circle', key: 'topic', value: 'no' }],
  [ada, { type: 'record-set', app: 'settings', scope: 'circle', key: 'topic', value: null }],
  [ada, { type: 'record-set', app: 'settings', scope: 'circle', key: 'gone', value: 1 }],
  [ada, { type: 'record-del', app: 'settings', scope: 'circle', key: 'gone' }],
  [ada, { type: 'set-role', identity: bo.identity, role: 'admin' }],
  [bo, { type: 'set-role', identity: ada.identity, role: 'member' }],
  [ada, { type: 'set-format', format: 2 }],
  [bo, { type: 'set-format', format: 1 }],
  [bo, { type: 'remove-member', identity: cy.identity }],
  [cy, { type: 'offer', offer }],
  [bo, { type: 'paint-it-red' } as unknown as CircleOp],
];

const msgId = (char: string) => char.repeat(16);

// Format 2: chat and kept records (ADR 0042 §1–§5, ADR 0044 §7).
const LOG2: Array<[CircleMemberIntro, CircleOp]> = [
  [ada, { type: 'create', name: 'Garden club', format: 2, member: ada }],
  [ada, inviteOp('7')],
  [ada, inviteOp('8')],
  [ada, { type: 'add-member', member: bo, invite: hex('7') }],
  [ada, { type: 'add-member', member: cy, invite: hex('8') }],
  [ada, { type: 'chat-post', channel: 'general', id: msgId('a'), text: 'Seed swap on the 9th?', at: 1000 }],
  [bo, { type: 'chat-post', channel: 'general', id: msgId('b'), text: 'Count me in', at: 1100, agent: { slug: 'hermes', name: ' Hermes ' } }],
  [bo, { type: 'chat-post', channel: 'general', id: msgId('b'), text: 'Again', at: 1200 }],
  [cy, { type: 'chat-post', channel: 'general', id: 'short', text: 'Bad id', at: 1300 }],
  [cy, { type: 'chat-post', channel: 'general', id: msgId('c'), text: '   ', at: 1300 }],
  [cy, { type: 'chat-post', channel: 'General', id: msgId('c'), text: 'Bad channel', at: 1300 }],
  [cy, { type: 'chat-post', channel: 'general', id: msgId('c'), text: 'x'.repeat(12 * 1024 + 1), at: 1300 }],
  [cy, { type: 'chat-post', channel: 'general', id: msgId('c'), text: 'Shared', at: 1400, shared: { role: 'assistant', model: 'small' } }],
  [cy, { type: 'chat-post', channel: 'general', id: msgId('d'), text: '', at: 1500, call: { id: msgId('e') } }],
  [cy, { type: 'chat-post', channel: 'design', id: msgId('a'), text: 'Other channel', at: 1600 }],
  [bo, { type: 'chat-edit', channel: 'general', id: msgId('a'), text: 'Not mine' }],
  [ada, { type: 'chat-edit', channel: 'general', id: msgId('a'), text: 'Seed swap on the 10th?' }],
  [cy, { type: 'chat-edit', channel: 'general', id: msgId('d'), text: '', call: { id: msgId('e'), ended: 2500 } }],
  [cy, { type: 'chat-edit', channel: 'general', id: msgId('d'), text: '', call: { id: msgId('f'), ended: 2500 } }],
  [bo, { type: 'chat-delete', channel: 'general', author: cy.identity, id: msgId('c') }],
  [ada, { type: 'chat-delete', channel: 'general', author: cy.identity, id: msgId('c') }],
  [bo, { type: 'chat-delete', channel: 'general', author: bo.identity, id: msgId('b') }],
  [bo, { type: 'chat-edit', channel: 'general', id: msgId('b'), text: 'Too late' }],
  [cy, { type: 'record-set', app: 'garden', scope: 'member', key: 'plot', value: { row: 3 }, keep: true }],
  [cy, { type: 'record-set', app: 'garden', scope: 'member', key: 'note', value: 'gone with Cy' }],
  [cy, { type: 'record-set', app: 'garden', scope: 'member', key: 'shed', value: 'stays', keep: true }],
  [ada, { type: 'record-set', app: 'garden', scope: 'circle', key: 'map', value: 1, keep: true }],
  [bo, { type: 'record-del', app: 'garden', scope: 'member', key: 'plot', identity: cy.identity }],
  [ada, { type: 'record-del', app: 'garden', scope: 'member', key: 'plot', identity: cy.identity }],
  [ada, { type: 'remove-member', identity: cy.identity }],
  [cy, { type: 'chat-post', channel: 'general', id: msgId('9'), text: 'After removal', at: 3000 }],
  [bo, { type: 'record-del', app: 'garden', scope: 'member', key: 'plot', identity: cy.identity }],
  [ada, { type: 'record-del', app: 'garden', scope: 'member', key: 'note', identity: cy.identity }],
  [ada, { type: 'record-del', app: 'garden', scope: 'member', key: 'plot', identity: cy.identity }],
];

async function replay(log: Array<[CircleMemberIntro, CircleOp]>, supportedFormat: number) {
  const data = new Map<string, unknown>();
  const view: CircleView = {
    get: async (key) => (data.has(key) ? { value: data.get(key) } : null),
    put: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
    list: async (prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => data.get(key)),
  };
  const writers: Array<[string, string, boolean?]> = [];
  const host: CircleHost = {
    addWriter: async (key, { indexer }) => void writers.push(['add', key.toString('hex'), indexer]),
    removeWriter: async (key) => void writers.push(['remove', key.toString('hex')]),
    removeable: () => true,
    interrupt: () => {
      throw new Error('these logs never stop');
    },
  };
  const skipped: string[] = [];
  await applyCircleNodes(
    log.map(([author, value]) => ({ value, from: { key: Buffer.from(author.writer, 'hex') } })),
    view,
    host,
    {
      verify: (_message, signature, publicKey) => signature[0] === publicKey[0],
      supportedFormat,
      onSkip: (reason) => skipped.push(reason),
    }
  );
  const result = { view: Object.fromEntries([...data].sort(([a], [b]) => (a < b ? -1 : 1))), writers, skipped };
  return `${JSON.stringify(result, null, 2)}\n`;
}

describe('format 1', () => {
  it('turns this log into this view', async () => {
    await expect(await replay(LOG, 2)).toMatchFileSnapshot('./fixtures/circleOpsFormat1.json');
  });
});

describe('format 2', () => {
  it('turns this log into this view', async () => {
    await expect(await replay(LOG2, 2)).toMatchFileSnapshot('./fixtures/circleOpsFormat2.json');
  });
});
