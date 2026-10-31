import { describe, expect, it, vi } from 'vitest';
import {
  applyCircleNodes,
  CIRCLE_FORMAT,
  CIRCLE_KEY,
  circleRecordKey,
  MAX_RECORD_VALUE_BYTES,
  lostMembership,
  memberKey,
  memberRecordKey,
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
    interrupt: (reason: string) => {
      throw new Error(`interrupted: ${reason}`);
    },
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
    [ada, { type: 'create', name: 'Garden club', format: 1, member: ada }],
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
      [ada, { type: 'create', name: 'Garden club', format: 1, member: ada }],
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
      [bo, { type: 'create', name: 'Garden club', format: 1, member: ada }],
      [ada, { type: 'create', name: 'Garden club', format: 1, member: ada }],
      [ada, { type: 'create', name: 'Again', format: 1, member: ada }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['bad creator intro', 'the Circle already exists']);
    expect(roleOf(view, ada)).toBe('admin');
  });

  it('needs a format to create a Circle', async () => {
    const view = fakeView();
    const skipped = await run(view, fakeHost(), [
      [ada, { type: 'create', name: 'Garden club', member: ada } as unknown as CircleOp],
      [ada, { type: 'create', name: 'Garden club', format: 0, member: ada }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['bad format', 'bad format']);
    expect(view.data.has(CIRCLE_KEY)).toBe(false);
  });

  it('stops on a Circle created at a format this build can’t apply', async () => {
    await expect(
      run(fakeView(), fakeHost(), [[ada, { type: 'create', name: 'Garden club', format: CIRCLE_FORMAT + 1, member: ada }]])
    ).rejects.toThrow('interrupted');
  });

  it('raises the format for a build that supports it, and only an admin can', async () => {
    const { view, host } = await circleWithBo();
    const onSkip = vi.fn();
    const apply = (author: CircleMemberIntro, format: unknown) =>
      applyCircleNodes(
        [{ value: { type: 'set-format', format }, from: { key: Buffer.from(author.writer, 'hex') } }],
        view,
        host,
        { verify, onSkip, supportedFormat: 2 }
      );
    await apply(bo, 2);
    await apply(ada, 1);
    await apply(ada, 1.5);
    await apply(ada, 2);
    expect(onSkip.mock.calls.map(([reason]) => reason)).toEqual(['only admins change the format', 'bad format', 'bad format']);
    expect(view.data.get(CIRCLE_KEY)).toEqual({ name: 'Garden club', format: 2 });
  });

  it('stops on a later format from an admin, and leaves the view alone', async () => {
    const { view, host } = await circleWithBo();
    await expect(run(view, host, [[ada, { type: 'set-format', format: CIRCLE_FORMAT + 1 }]])).rejects.toThrow('interrupted');
    expect(view.data.get(CIRCLE_KEY)).toEqual({ name: 'Garden club', format: 1 });
  });

  it('never stops for what a member appends', async () => {
    const { view, host } = await circleWithBo();
    const skipped = await run(view, host, [
      [bo, { type: 'set-format', format: CIRCLE_FORMAT + 1 }],
      [bo, { type: 'paint-it-red', format: CIRCLE_FORMAT + 1 } as unknown as CircleOp],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['only admins change the format', 'unknown operation']);
  });

  it('lets only admins write Circle records, and nobody write another member’s', async () => {
    const { view, host } = await circleWithBo();
    const skipped = await run(view, host, [
      [bo, { type: 'record-set', app: 'settings', scope: 'circle', key: 'topic', value: 'peas' }],
      [ada, { type: 'record-set', app: 'settings', scope: 'circle', key: 'topic', value: 'beans' }],
      [ada, { type: 'record-set', app: 'profile', scope: 'member', key: 'bio', value: 'Ada’s' }],
      [bo, { type: 'record-set', app: 'profile', scope: 'member', key: 'bio', value: 'Bo’s' }],
      [bo, { type: 'record-del', app: 'settings', scope: 'circle', key: 'topic' }],
      [bo, { type: 'record-del', app: 'profile', scope: 'member', key: 'bio' }],
    ]);
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual(['only admins write Circle records', 'only admins write Circle records']);
    expect(view.data.get(circleRecordKey('settings', 'topic'))).toEqual({
      app: 'settings',
      scope: 'circle',
      identity: null,
      key: 'topic',
      value: 'beans',
    });
    expect((view.data.get(memberRecordKey(ada.identity, 'profile', 'bio')) as { value: string }).value).toBe('Ada’s');
    expect(view.data.has(memberRecordKey(bo.identity, 'profile', 'bio'))).toBe(false);
  });

  it('skips records with a bad shape or an oversized value', async () => {
    const { view, host } = await circleWithBo();
    const ops: CircleOp[] = [
      { type: 'record-set', app: 'a/b', scope: 'circle', key: 'k', value: 1 },
      { type: 'record-set', app: 'app', scope: 'circle', key: '../k', value: 1 },
      { type: 'record-set', app: 'app', scope: 'everyone' as 'circle', key: 'k', value: 1 },
      { type: 'record-set', app: 'app', scope: 'circle', key: 'k' } as CircleOp,
      { type: 'record-set', app: 'app', scope: 'circle', key: 'k', value: 'x'.repeat(MAX_RECORD_VALUE_BYTES) },
    ];
    const skipped = await run(view, host, ops.map((op) => [ada, op]));
    expect(skipped.mock.calls.map(([reason]) => reason)).toEqual([
      'bad record',
      'bad record',
      'bad record',
      'bad record value',
      'bad record value',
    ]);
    const fits = 'x'.repeat(MAX_RECORD_VALUE_BYTES - 2);
    await run(view, host, [[ada, { type: 'record-set', app: 'app', scope: 'circle', key: 'k', value: fits }]]);
    expect(view.data.has(circleRecordKey('app', 'k'))).toBe(true);
  });

  it('keeps records of apps it knows nothing about, and never reads the value', async () => {
    const { view, host } = await circleWithBo();
    const value = { nested: [1, { type: 'remove-member' }] };
    await run(view, host, [[bo, { type: 'record-set', app: 'unheard.of', scope: 'member', key: 'k', value }]]);
    expect((view.data.get(memberRecordKey(bo.identity, 'unheard.of', 'k')) as { value: unknown }).value).toEqual(value);
  });

  it('clears a removed member’s records, and leaves others’ and the Circle’s', async () => {
    const { view, host } = await circleWithBo();
    await run(view, host, [
      [ada, { type: 'record-set', app: 'settings', scope: 'circle', key: 'topic', value: 1 }],
      [ada, { type: 'record-set', app: 'profile', scope: 'member', key: 'bio', value: 1 }],
      [bo, { type: 'record-set', app: 'profile', scope: 'member', key: 'bio', value: 2 }],
      [bo, { type: 'record-set', app: 'other', scope: 'member', key: 'x', value: 3 }],
      [ada, { type: 'remove-member', identity: bo.identity }],
    ]);
    expect([...view.data.keys()].filter((key) => key.startsWith('records/')).sort()).toEqual([
      circleRecordKey('settings', 'topic'),
      memberRecordKey(ada.identity, 'profile', 'bio'),
    ]);
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

describe('lostMembership', () => {
  const record = (identity: string, writer: string) => ({ identity, writer }) as CircleMemberRecord;
  const self = { identity: 'bo', writer: 'new' };
  const ada = record('ada', 'a');

  it('is true when the record holding this writer goes', () => {
    expect(lostMembership([ada, record('bo', 'new')], [ada], self)).toBe(true);
  });

  it('ignores a rejoiner catching up through their old record and its removal', () => {
    expect(lostMembership([ada, record('bo', 'old')], [ada], self)).toBe(false);
  });

  it('is false while this identity is still a member, on any writer', () => {
    expect(lostMembership([ada, record('bo', 'new')], [ada, record('bo', 'other')], self)).toBe(false);
  });

  it('is false before this device has appeared in the view', () => {
    expect(lostMembership([], [ada], self)).toBe(false);
  });
});
