import { describe, expect, it, vi } from 'vitest';
import {
  applyCircleNodes,
  memberKey,
  offerKey,
  type CircleHost,
  type CircleMemberIntro,
  type CircleMemberRecord,
  type CircleOp,
  type CircleView,
} from '../circleOps';

/** A Map-backed view; prefixes are listed in key order, as Hyperbee does. */
function fakeView(): CircleView & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? { value: data.get(key) } : null),
    put: async (key, value) => void data.set(key, value),
    del: async (key) => void data.delete(key),
    list: async (prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => data.get(key)),
  };
}

function fakeHost(): CircleHost & { writers: Map<string, boolean> } {
  const writers = new Map<string, boolean>();
  return {
    writers,
    addWriter: vi.fn(async (key: Buffer, { indexer }: { indexer: boolean }) => void writers.set(key.toString('hex'), indexer)),
    removeWriter: vi.fn(async (key: Buffer) => void writers.delete(key.toString('hex'))),
    removeable: () => true,
  };
}

const hex = (char: string, length = 64) => char.repeat(length);

/** A signature is "valid" when it starts with the identity's first byte; enough to tell forged from real. */
const verify = (_message: Buffer, signature: Buffer, publicKey: Buffer) => signature[0] === publicKey[0];

function intro(char: string, name: string): CircleMemberIntro {
  return {
    identity: hex(char),
    name,
    writer: hex(String.fromCharCode(char.charCodeAt(0) + 1)),
    device: hex(String.fromCharCode(char.charCodeAt(0) + 2)),
    signature: hex(char, 128),
  };
}

const ada = intro('a', 'Ada');
const bo = intro('4', 'Bo');
const cy = intro('7', 'Cy');

async function run(view: CircleView, host: CircleHost, ops: Array<[CircleMemberIntro, CircleOp]>, onSkip = vi.fn()) {
  await applyCircleNodes(
    ops.map(([author, value]) => ({ value, from: { key: Buffer.from(author.writer, 'hex') } })),
    view,
    host,
    { verify, onSkip }
  );
  return onSkip;
}

const invite = (id: string): CircleOp => ({ type: 'invite', invite: { id: hex(id), publicKey: hex('e'), expires: 0 } });

async function circleWithBo() {
  const view = fakeView();
  const host = fakeHost();
  await run(view, host, [
    [ada, { type: 'create', name: 'Garden club', member: ada }],
    [ada, invite('1')],
    [ada, { type: 'add-member', member: bo, invite: hex('1') }],
  ]);
  return { view, host };
}

const roleOf = (view: ReturnType<typeof fakeView>, who: CircleMemberIntro) =>
  (view.data.get(memberKey(who.identity)) as CircleMemberRecord | undefined)?.role;

describe('applyCircleNodes', () => {
  it('adds an invited member as a non-indexing writer and spends the invite', async () => {
    const { view, host } = await circleWithBo();
    expect(roleOf(view, bo)).toBe('member');
    expect(host.writers.get(bo.writer)).toBe(false);
    const skipped = await run(view, host, [[ada, { type: 'add-member', member: cy, invite: hex('1') }]]);
    expect(skipped).toHaveBeenCalledWith('invite not usable', expect.anything());
    expect(roleOf(view, cy)).toBeUndefined();
  });

  it('refuses an intro its identity did not sign', async () => {
    const view = fakeView();
    const host = fakeHost();
    await run(view, host, [
      [ada, { type: 'create', name: 'Garden club', member: ada }],
      [ada, invite('1')],
    ]);
    const skipped = await run(view, host, [[ada, { type: 'add-member', member: { ...bo, signature: hex('0', 128) }, invite: hex('1') }]]);
    expect(skipped).toHaveBeenCalledWith('bad member intro', expect.anything());
  });

  it('skips admin operations from a member, but lets them leave', async () => {
    const { view, host } = await circleWithBo();
    const skipped = await run(view, host, [
      [bo, invite('2')],
      [bo, { type: 'set-role', identity: bo.identity, role: 'admin' }],
      [bo, { type: 'remove-member', identity: ada.identity }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual([
      'only admins invite',
      'only admins change roles',
      'only admins remove others',
    ]);
    await run(view, host, [[bo, { type: 'remove-member', identity: bo.identity }]]);
    expect(roleOf(view, bo)).toBeUndefined();
    expect(host.writers.has(bo.writer)).toBe(false);
  });

  it('makes an admin an indexer, and never removes or demotes the last admin', async () => {
    const { view, host } = await circleWithBo();
    const skipped = await run(view, host, [
      [ada, { type: 'set-role', identity: ada.identity, role: 'member' }],
      [ada, { type: 'remove-member', identity: ada.identity }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['the last admin stays admin', 'the last admin cannot leave']);

    await run(view, host, [[ada, { type: 'set-role', identity: bo.identity, role: 'admin' }]]);
    expect(host.writers.get(bo.writer)).toBe(true);
    await run(view, host, [[bo, { type: 'set-role', identity: ada.identity, role: 'member' }]]);
    expect(roleOf(view, ada)).toBe('member');
    expect(host.writers.get(ada.writer)).toBe(false);
  });

  it('stops a removed writer acting, and skips unknown and ack nodes', async () => {
    const { view, host } = await circleWithBo();
    await run(view, host, [[ada, { type: 'remove-member', identity: bo.identity }]]);
    const skipped = await run(view, host, [
      [bo, { type: 'remove-member', identity: bo.identity }],
      [ada, { type: 'paint-it-red' } as unknown as CircleOp],
    ]);
    await applyCircleNodes([{ value: null, from: { key: Buffer.from(ada.writer, 'hex') } }], view, host, { verify, onSkip: skipped });
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['no such member', 'unknown operation']);
  });

  it('creates once, and only with the bootstrap writer as the creator', async () => {
    const view = fakeView();
    const host = fakeHost();
    const skipped = await run(view, host, [
      [bo, { type: 'create', name: 'Garden club', member: ada }],
      [ada, { type: 'create', name: 'Garden club', member: ada }],
      [ada, { type: 'create', name: 'Again', member: ada }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['bad creator intro', 'the Circle already exists']);
    expect(roleOf(view, ada)).toBe('admin');
  });

  it('stores a member’s own offer, cleaned, and drops it when they withdraw or leave', async () => {
    const { view, host } = await circleWithBo();
    const offer = { models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true, extra: 'x' }], available: true, away: false };
    await run(view, host, [[bo, { type: 'offer', offer } as CircleOp]]);
    expect(view.data.get(offerKey(bo.identity))).toEqual({
      identity: bo.identity,
      models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }],
      available: true,
      away: false,
    });

    await run(view, host, [[bo, { type: 'withdraw-offer' }]]);
    expect(view.data.has(offerKey(bo.identity))).toBe(false);

    await run(view, host, [
      [bo, { type: 'offer', offer }],
      [ada, { type: 'remove-member', identity: bo.identity }],
    ]);
    expect(view.data.has(offerKey(bo.identity))).toBe(false);
  });

  it('skips a malformed offer and one from a writer who is not a member', async () => {
    const { view, host } = await circleWithBo();
    const good = { models: [{ id: 'm', tools: false }], available: true, away: false };
    const skipped = await run(view, host, [
      [bo, { type: 'offer', offer: { ...good, models: [{ id: 'm', tools: false }, { id: 'm', tools: false }] } }],
      [bo, { type: 'offer', offer: { ...good, models: [{ id: 'm', tools: false, contextLength: -1 }] } }],
      [bo, { type: 'offer', offer: { ...good, models: Array.from({ length: 33 }, (_, i) => ({ id: `m${i}`, tools: false })) } }],
      [bo, { type: 'offer', offer: { ...good, available: 'yes' } as unknown as typeof good }],
      [cy, { type: 'offer', offer: good }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['bad offer', 'bad offer', 'bad offer', 'bad offer', 'not a member']);
    expect(view.data.has(offerKey(bo.identity))).toBe(false);
    expect(view.data.has(offerKey(cy.identity))).toBe(false);
  });
});
