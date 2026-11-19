import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectEvent } from '../../../../shared/types/circles';
import {
  DIRECT_ACK_DELAY_MS,
  DIRECT_RESEND_MS,
  DIRECT_SEND_BATCH,
  DIRECT_TICK_MS,
  DirectMessages,
  MAX_ACK_IDS,
  directPayloadOf,
  type DirectFile,
  type DirectPerson,
} from '../directMessages';
import { MAX_DIRECT_TEXT_BYTES } from '../../../../shared/circleDirect';

const KEY = 'cc'.repeat(32);
const ME = 'aa'.repeat(32);
const MAYA = 'bb'.repeat(32);
const SAM = 'dd'.repeat(32);

/** Settle the service's queued work: each step awaits a load or save. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function harness(start: DirectPerson[] = [{ identity: MAYA, name: 'Maya', online: true }]) {
  let people: DirectPerson[] | null = start;
  let next = 0;
  const disk = new Map<string, string>();
  const sent: { topic: string; payload: Record<string, unknown>; to: string }[] = [];
  const events: DirectEvent[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  /** Saves and sends in the order they happened, with each save's outbox `sent` flags. */
  const order: string[] = [];
  /** The disk as it was at each send. */
  const diskAtSend: Map<string, string>[] = [];
  const control = {
    running: true,
    throwOn: null as ((payload: Record<string, unknown>) => boolean) | null,
    /** Circles in this device's store. */
    known: new Set([KEY]),
    removeFails: false,
  };
  const dms = new DirectMessages({
    identity: () => ME,
    people: () => people,
    send: (_key, topic, payload, to) => {
      if (!control.running) return false;
      if (control.throwOn?.(payload as Record<string, unknown>)) throw new Error('That signal payload is too long.');
      order.push(`send ${topic}`);
      diskAtSend.push(new Map(disk));
      sent.push({ topic, payload: payload as Record<string, unknown>, to });
      return true;
    },
    keys: async () => [...disk.keys()],
    known: (key) => control.known.has(key),
    load: async (key) => (disk.has(key) ? (JSON.parse(disk.get(key)!) as DirectFile) : null),
    save: async (key, file) => {
      order.push(`save ${file.outbox.map((item) => (item.sent ? 'sent' : 'unsent')).join(',')}`);
      disk.set(key, JSON.stringify(file));
    },
    remove: async (key) => {
      if (control.removeFails) throw new Error('EACCES');
      disk.delete(key);
    },
    newId: () => (next += 1).toString(16).padStart(16, '0'),
    now: () => Date.now(),
    emit: (event) => void events.push(event),
    log: (event, data) => void logs.push({ event, data }),
  });
  return {
    dms,
    disk,
    sent,
    events,
    logs,
    order,
    diskAtSend,
    control,
    /** Resolves once what went to devices that connected has been sent. */
    setPeople(next: DirectPerson[] | null) {
      people = next;
      return dms.onPeopleChanged();
    },
    /** Change who the Circle says its members are without telling the service, as before a snapshot lands. */
    setPeopleQuietly(next: DirectPerson[] | null) {
      people = next;
    },
  };
}

const op = (n: number) => n.toString(16).padStart(16, '0');

describe('direct message payloads', () => {
  const message = { op: op(1), id: op(2), text: 'Hi', at: 5 };

  it('accepts the five topics in their right shape', () => {
    expect(directPayloadOf('dm.message', message)).toEqual({ topic: 'dm.message', ...message, reply: null });
    expect(directPayloadOf('dm.message', { ...message, reply: { author: MAYA, id: op(3) } })).toMatchObject({
      reply: { author: MAYA, id: op(3) },
    });
    expect(directPayloadOf('dm.edit', { op: op(1), id: op(2), text: 'Hey' })).toEqual({ topic: 'dm.edit', op: op(1), id: op(2), text: 'Hey' });
    expect(directPayloadOf('dm.delete', { op: op(1), id: op(2) })).toEqual({ topic: 'dm.delete', op: op(1), id: op(2) });
    expect(directPayloadOf('dm.ack', { ids: [op(1)] })).toEqual({ topic: 'dm.ack', ids: [op(1)] });
    expect(directPayloadOf('dm.typing', {})).toEqual({ topic: 'dm.typing' });
  });

  it('drops anything of the wrong shape or size', () => {
    expect(directPayloadOf('dm.message', { ...message, text: '   ' })).toBeNull();
    expect(directPayloadOf('dm.message', { ...message, text: 'x'.repeat(MAX_DIRECT_TEXT_BYTES + 1) })).toBeNull();
    // Bytes, not characters: 1,025 three-byte characters is over.
    expect(directPayloadOf('dm.message', { ...message, text: '€'.repeat(1025) })).toBeNull();
    expect(directPayloadOf('dm.message', { ...message, at: -1 })).toBeNull();
    // Past the latest time a Date can hold.
    expect(directPayloadOf('dm.message', { ...message, at: 8_640_000_000_000_001 })).toBeNull();
    expect(directPayloadOf('dm.message', { ...message, id: 'nope' })).toBeNull();
    expect(directPayloadOf('dm.message', { ...message, reply: { author: 'me', id: op(3) } })).toBeNull();
    expect(directPayloadOf('dm.edit', { op: op(1), id: op(2) })).toBeNull();
    expect(directPayloadOf('dm.ack', { ids: [] })).toBeNull();
    expect(directPayloadOf('dm.ack', { ids: Array.from({ length: MAX_ACK_IDS + 1 }, (_, i) => op(i + 1)) })).toBeNull();
    expect(directPayloadOf('dm.typing', null)).toBeNull();
    expect(directPayloadOf('dm.typing', [])).toBeNull();
    expect(directPayloadOf('dm.other', {})).toBeNull();
  });
});

describe('DirectMessages', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends to an online person and marks the message delivered when acknowledged', async () => {
    const h = harness();
    await h.dms.start();
    const { id } = await h.dms.send(KEY, MAYA, 'Snacks Thursday?');
    expect(h.sent).toEqual([{ topic: 'dm.message', to: MAYA, payload: { id, text: 'Snacks Thursday?', at: Date.now(), op: expect.any(String) } }]);
    expect((await h.dms.messages(KEY, MAYA)).messages[0]!.delivery).toBe('sending');

    await h.dms.receive(KEY, MAYA, 'dm.ack', { ids: [h.sent[0]!.payload.op] });
    const [message] = (await h.dms.messages(KEY, MAYA)).messages;
    expect(message!.delivery).toBe('delivered');
    expect(JSON.parse(h.disk.get(KEY)!).outbox).toEqual([]);
    h.dms.stop();
  });

  it('keeps a message for someone offline and sends it when their device connects', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'Pages 180 to 262.');
    expect(h.sent).toEqual([]);
    expect((await h.dms.messages(KEY, SAM)).messages[0]!.delivery).toBe('waiting');
    expect((await h.dms.conversations(KEY))[0]).toMatchObject({ peer: SAM, waiting: 1, online: false });

    await h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    expect(h.sent.map((s) => s.topic)).toEqual(['dm.message']);
    expect(h.events.at(-1)).toMatchObject({ kind: 'change', message: { delivery: 'sending' } });
    h.dms.stop();
  });

  it('keeps the outbox across a restart', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'Still there?');
    h.dms.stop();

    const again = harness([{ identity: SAM, name: 'Sam', online: true }]);
    for (const [key, value] of h.disk) again.disk.set(key, value);
    await again.dms.start();
    expect(again.sent.map((s) => s.payload.text)).toEqual(['Still there?']);
    again.dms.stop();
  });

  it('sends again every 30 seconds while unacknowledged', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.send(KEY, MAYA, 'Hello?');
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DIRECT_RESEND_MS - DIRECT_TICK_MS);
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DIRECT_TICK_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.payload.op).toBe(h.sent[0]!.payload.op);
    h.dms.stop();
  });

  it('keeps at most a batch in flight and sends the rest as acknowledgements arrive', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    for (let i = 0; i < DIRECT_SEND_BATCH + 3; i += 1) await h.dms.send(KEY, SAM, `Message ${i}`);
    await h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    expect(h.sent).toHaveLength(DIRECT_SEND_BATCH);
    await h.dms.receive(KEY, SAM, 'dm.ack', { ids: h.sent.slice(0, 3).map((s) => s.payload.op) });
    expect(h.sent).toHaveLength(DIRECT_SEND_BATCH + 3);
    expect(h.sent.at(-1)!.payload.text).toBe(`Message ${DIRECT_SEND_BATCH + 2}`);
    h.dms.stop();
  });

  it('stores a received message once, tells listeners, and acknowledges in a batch after saving', async () => {
    const h = harness();
    await h.dms.start();
    const payload = (n: number) => ({ op: op(100 + n), id: op(200 + n), text: `Hi ${n}`, at: 1 });
    await h.dms.receive(KEY, MAYA, 'dm.message', payload(1));
    await h.dms.receive(KEY, MAYA, 'dm.message', payload(2));
    await h.dms.receive(KEY, MAYA, 'dm.message', payload(1));
    expect(h.events.filter((e) => e.kind === 'message')).toHaveLength(2);
    expect(JSON.parse(h.disk.get(KEY)!).conversations[MAYA].messages).toHaveLength(2);
    expect(h.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.sent).toEqual([{ topic: 'dm.ack', to: MAYA, payload: { ids: [op(101), op(102)] } }]);
    h.dms.stop();
  });

  it('applies the sender’s edit and delete, and ignores them for a message it never had', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'Late', at: 1 });
    await h.dms.receive(KEY, MAYA, 'dm.edit', { op: op(3), id: op(2), text: 'Ten minutes late' });
    expect((await h.dms.messages(KEY, MAYA)).messages[0]).toMatchObject({ text: 'Ten minutes late', edited: true, mine: false, delivery: null });
    await h.dms.receive(KEY, MAYA, 'dm.delete', { op: op(4), id: op(2) });
    expect((await h.dms.messages(KEY, MAYA)).messages[0]).toMatchObject({ text: '', deleted: true });
    await h.dms.receive(KEY, MAYA, 'dm.edit', { op: op(5), id: op(9), text: 'Who?' });
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.sent[0]!.payload.ids).toEqual([op(1), op(3), op(4), op(5)]);
    h.dms.stop();
  });

  it('drops a malformed signal without storing or acknowledging it', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'x'.repeat(MAX_DIRECT_TEXT_BYTES + 1), at: 1 });
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.disk.size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.logs).toContainEqual({ event: 'dm-dropped', data: { circle: KEY.slice(0, 8), topic: 'dm.message' } });
    h.dms.stop();
  });

  it('deletes a message never sent from the outbox, and sends a delete for one that was', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    const { id: first } = await h.dms.send(KEY, SAM, 'Oops');
    expect((await h.dms.messages(KEY, SAM)).messages[0]!.neverSent).toBe(true);
    expect(await h.dms.delete(KEY, SAM, first)).toEqual({ unsent: true });
    expect((await h.dms.messages(KEY, SAM)).messages).toEqual([]);
    expect(h.events.at(-1)).toEqual({ kind: 'unsent', circleKey: KEY, peer: SAM, id: first });

    h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    const { id: second } = await h.dms.send(KEY, SAM, 'Hello');
    expect((await h.dms.messages(KEY, SAM)).messages[0]!.neverSent).toBe(false);
    expect(await h.dms.delete(KEY, SAM, second)).toEqual({ unsent: false });
    expect(h.sent.map((s) => s.topic)).toEqual(['dm.message', 'dm.delete']);
    expect((await h.dms.messages(KEY, SAM)).messages[0]).toMatchObject({ deleted: true, text: '' });
    h.dms.stop();
  });

  it('folds an edit into a message not yet sent', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    const { id } = await h.dms.send(KEY, SAM, 'Pages 108');
    await h.dms.edit(KEY, SAM, id, 'Pages 180');
    await h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ topic: 'dm.message', payload: { text: 'Pages 180' } });
    h.dms.stop();
  });

  it('refuses text past the limit, someone outside the Circle, and replies to another conversation', async () => {
    const h = harness();
    await h.dms.start();
    await expect(h.dms.send(KEY, MAYA, 'x'.repeat(MAX_DIRECT_TEXT_BYTES + 1))).rejects.toThrow('at most');
    await expect(h.dms.send(KEY, SAM, 'Hi')).rejects.toThrow('aren’t in this Circle');
    await expect(h.dms.send(KEY, ME, 'Hi')).rejects.toThrow('That is you');
    await expect(h.dms.send(KEY, MAYA, 'Re', { author: SAM, id: op(1) })).rejects.toThrow('isn’t in this conversation');
    h.setPeople(null);
    await expect(h.dms.send(KEY, MAYA, 'Hi')).rejects.toThrow('isn’t open');
    h.dms.stop();
  });

  it('ends a conversation when the other person leaves, dropping what waited for them', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'See you?');
    h.setPeople([]);
    await settle();
    expect(h.events.at(-1)).toEqual({ kind: 'ended', circleKey: KEY, peer: SAM });
    const [conversation] = await h.dms.conversations(KEY);
    expect(conversation).toMatchObject({ ended: true, name: 'Sam', waiting: 0 });
    expect(JSON.parse(h.disk.get(KEY)!).outbox).toEqual([]);
    await expect(h.dms.send(KEY, SAM, 'Hello?')).rejects.toThrow();
    h.dms.stop();
  });

  it('doesn’t end anything while the Circle can’t say who its members are', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'Hi');
    h.setPeople(null);
    expect((await h.dms.conversations(KEY))[0]!.ended).toBe(false);
    h.dms.stop();
  });

  it('forgets a Circle’s DMs when this user leaves it', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'Hi');
    await h.dms.forget(KEY);
    expect(h.disk.has(KEY)).toBe(false);
    expect(await h.dms.conversations(KEY)).toEqual([]);
    h.dms.stop();
  });

  it('sends typing at most every 3 seconds, and only to someone online', async () => {
    const h = harness([
      { identity: MAYA, name: 'Maya', online: true },
      { identity: SAM, name: 'Sam', online: false },
    ]);
    h.dms.typing(KEY, MAYA);
    h.dms.typing(KEY, MAYA);
    h.dms.typing(KEY, SAM);
    vi.advanceTimersByTime(3_000);
    h.dms.typing(KEY, MAYA);
    expect(h.sent.map((s) => [s.topic, s.to])).toEqual([
      ['dm.typing', MAYA],
      ['dm.typing', MAYA],
    ]);
    await h.dms.receive(KEY, MAYA, 'dm.typing', {});
    expect(h.events).toEqual([{ kind: 'typing', circleKey: KEY, peer: MAYA }]);
  });

  it('remembers across a restart that a message went, so deleting it sends a delete', async () => {
    const h = harness();
    await h.dms.start();
    const { id } = await h.dms.send(KEY, MAYA, 'Did this arrive?');
    await settle();
    h.dms.stop();

    const again = harness([{ identity: MAYA, name: 'Maya', online: false }]);
    for (const [key, value] of h.disk) again.disk.set(key, value);
    await again.dms.start();
    expect(await again.dms.delete(KEY, MAYA, id)).toEqual({ unsent: false });
    expect(JSON.parse(again.disk.get(KEY)!).outbox.map((item: { topic: string }) => item.topic)).toEqual(['dm.message', 'dm.delete']);
    again.dms.stop();
  });

  it('sends an edit to a message that already went as an edit, not by rewriting it', async () => {
    const h = harness();
    await h.dms.start();
    const { id } = await h.dms.send(KEY, MAYA, 'Pages 108');
    await h.dms.edit(KEY, MAYA, id, 'Pages 180');
    expect(h.sent.map((s) => [s.topic, s.payload.text])).toEqual([
      ['dm.message', 'Pages 108'],
      ['dm.edit', 'Pages 180'],
    ]);
    h.dms.stop();
  });

  it('refuses text that would be too long once escaped, and survives a send that throws', async () => {
    const h = harness();
    await h.dms.start();
    // 3,000 quotes are 3,000 bytes of text but 6,000 once escaped as JSON.
    await expect(h.dms.send(KEY, MAYA, `x${'"'.repeat(3000)}`)).rejects.toThrow('at most');
    expect(await h.dms.conversations(KEY)).toEqual([]);

    const broken = new DirectMessages({
      identity: () => ME,
      people: () => [{ identity: MAYA, name: 'Maya', online: true }],
      send: () => {
        throw new Error('That signal payload is too long.');
      },
      keys: async () => [],
      known: () => true,
      load: async () => null,
      save: async () => undefined,
      remove: async () => undefined,
      newId: () => op(Math.floor(Math.random() * 1e9) + 1),
      now: () => Date.now(),
      emit: () => undefined,
      log: () => undefined,
    });
    await broken.start();
    await broken.send(KEY, MAYA, 'Still kept');
    await vi.advanceTimersByTimeAsync(DIRECT_RESEND_MS * 2);
    expect((await broken.conversations(KEY))[0]).toMatchObject({ waiting: 1 });
    broken.stop();
    h.dms.stop();
  });

  it('applies a delete that arrives before its message, so a late resend stays deleted', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.receive(KEY, MAYA, 'dm.edit', { op: op(1), id: op(9), text: 'Edited first' });
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(2), id: op(9), text: 'Original', at: 1 });
    expect((await h.dms.messages(KEY, MAYA)).messages[0]).toMatchObject({ text: 'Edited first', edited: true });
    await h.dms.receive(KEY, MAYA, 'dm.delete', { op: op(3), id: op(8) });
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(4), id: op(8), text: 'Secret', at: 2 });
    const [, late] = (await h.dms.messages(KEY, MAYA)).messages;
    expect(late).toMatchObject({ text: '', deleted: true });
    expect(h.disk.get(KEY)).not.toContain('Secret');
    h.dms.stop();
  });

  it('marks what waited for someone who left as undelivered, and carries on if they rejoin', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'See you?');
    h.setPeople([]);
    await settle();
    expect((await h.dms.messages(KEY, SAM)).messages[0]!.delivery).toBe('undelivered');
    h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    await settle();
    expect(h.events.at(-1)).toEqual({ kind: 'reopened', circleKey: KEY, peer: SAM });
    await h.dms.send(KEY, SAM, 'Welcome back');
    expect(h.sent.map((s) => s.payload.text)).toEqual(['Welcome back']);
    h.dms.stop();
  });

  it('stores and acknowledges nothing for a Circle that isn’t open', async () => {
    const h = harness();
    await h.dms.start();
    h.setPeople(null);
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'Hi', at: 1 });
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.disk.size).toBe(0);
    expect(h.sent).toEqual([]);
    h.dms.stop();
  });

  it('starts no timer when stopped before it finished starting', async () => {
    const h = harness();
    const starting = h.dms.start();
    h.dms.stop();
    await starting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts the other person’s messages after the read position, and moves it forward only', async () => {
    const h = harness();
    await h.dms.start();
    for (let i = 1; i <= 3; i += 1) await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(100 + i), id: op(200 + i), text: `Hi ${i}`, at: i });
    await h.dms.send(KEY, MAYA, 'Mine never counts');
    expect((await h.dms.conversations(KEY))[0]!.unread).toBe(3);
    await h.dms.markRead(KEY, MAYA, op(202));
    expect((await h.dms.conversations(KEY))[0]!.unread).toBe(1);
    expect(h.events.at(-1)).toEqual({ kind: 'read', circleKey: KEY, peer: MAYA });
    await h.dms.markRead(KEY, MAYA, op(201));
    expect((await h.dms.conversations(KEY))[0]!.unread).toBe(1);
    await h.dms.receive(KEY, MAYA, 'dm.delete', { op: op(110), id: op(203) });
    expect((await h.dms.conversations(KEY))[0]!.unread).toBe(0);
    await expect(h.dms.markRead(KEY, MAYA, op(999))).rejects.toThrow('isn’t in this conversation');
    expect(JSON.parse(h.disk.get(KEY)!).conversations[MAYA].read).toEqual({ id: op(202), at: 2 });
    h.dms.stop();
  });

  it('keeps the read position by time when the message it named was unsent', async () => {
    const h = harness();
    await h.dms.start();
    const { id } = await h.dms.send(KEY, MAYA, 'Soon gone');
    await h.dms.markRead(KEY, MAYA, id);
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'After', at: Date.now() + 1 });
    await h.dms.receive(KEY, MAYA, 'dm.ack', { ids: [h.sent[0]!.payload.op] });
    await h.dms.delete(KEY, MAYA, id);
    expect((await h.dms.conversations(KEY))[0]!.unread).toBe(1);
    h.dms.stop();
  });

  it('measures text as it is escaped in the signal, and still takes what older builds sent', async () => {
    const h = harness();
    await h.dms.start();
    // 2,048 bytes of UTF-8, exactly 3,072 once each newline is escaped.
    const full = 'a\n'.repeat(1024);
    const { id } = await h.dms.send(KEY, MAYA, full);
    await expect(h.dms.send(KEY, MAYA, `${full}b`)).rejects.toThrow('at most');
    await expect(h.dms.edit(KEY, MAYA, id, `${full}\n`)).rejects.toThrow('at most');
    // An older build counted raw bytes only: 3,000 of them, 3,500 escaped.
    const older = `${'x'.repeat(2500)}${'\n'.repeat(500)}`;
    expect(directPayloadOf('dm.message', { op: op(1), id: op(2), text: older, at: 1 })).not.toBeNull();
    expect(directPayloadOf('dm.edit', { op: op(1), id: op(2), text: older })).not.toBeNull();
    h.dms.stop();
  });

  it('saves that a message went before the first time it goes', async () => {
    const h = harness();
    await h.dms.start();
    const { id } = await h.dms.send(KEY, MAYA, 'Did this arrive?');
    await settle();
    const firstSend = h.order.indexOf('send dm.message');
    expect(firstSend).toBeGreaterThan(-1);
    expect(h.order.slice(0, firstSend)).toContain('save sent');
    h.dms.stop();

    // A crash right after the first send: the file as it was then still knows the message went.
    const again = harness([{ identity: MAYA, name: 'Maya', online: false }]);
    for (const [key, value] of h.diskAtSend[0]!) again.disk.set(key, value);
    await again.dms.start();
    expect(await again.dms.delete(KEY, MAYA, id)).toEqual({ unsent: false });
    again.dms.stop();
  });

  it('shows a message edited before it was ever sent as not edited', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    const { id } = await h.dms.send(KEY, SAM, 'Pages 108');
    await h.dms.edit(KEY, SAM, id, 'Pages 180');
    expect((await h.dms.messages(KEY, SAM)).messages[0]).toMatchObject({ text: 'Pages 180', edited: false });
    h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    await settle();
    expect(h.sent.map((s) => s.topic)).toEqual(['dm.message']);
    expect(h.sent[0]!.payload).not.toHaveProperty('edited');
    h.dms.stop();
  });

  it('leaves a message unsent while Circles isn’t running, and sends it once it is', async () => {
    const h = harness();
    await h.dms.start();
    h.control.running = false;
    const { id } = await h.dms.send(KEY, MAYA, 'Anyone there?');
    await settle();
    expect(h.sent).toEqual([]);
    expect((await h.dms.messages(KEY, MAYA)).messages[0]!.neverSent).toBe(true);
    expect(JSON.parse(h.disk.get(KEY)!).outbox[0].sent).toBeUndefined();
    h.control.running = true;
    await vi.advanceTimersByTimeAsync(DIRECT_TICK_MS);
    expect(h.sent.map((s) => s.payload.id)).toEqual([id]);
    h.dms.stop();
  });

  it('sends the rest of the outbox when one signal throws', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    await h.dms.send(KEY, SAM, 'Broken');
    await h.dms.send(KEY, SAM, 'Fine');
    h.control.throwOn = (payload) => payload.text === 'Broken';
    h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    await settle();
    expect(h.sent.map((s) => s.payload.text)).toEqual(['Fine']);
    expect((await h.dms.messages(KEY, SAM)).messages[0]!.neverSent).toBe(true);
    h.dms.stop();
  });

  it('writes nothing for a Circle after this user leaves it, until they are back in it', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.send(KEY, MAYA, 'Hi');
    await h.dms.forget(KEY);
    // The snapshot that drops the Circle hasn't landed yet.
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'Late', at: 1 });
    await settle();
    expect(h.disk.has(KEY)).toBe(false);
    await h.setPeople(null);
    await h.setPeople([{ identity: MAYA, name: 'Maya', online: true }]);
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(3), id: op(4), text: 'Welcome back', at: 2 });
    expect(h.disk.has(KEY)).toBe(true);
    h.dms.stop();
  });

  it('removes a DM file whose Circle this device no longer has, when it starts', async () => {
    const h = harness();
    const ORPHAN = 'ee'.repeat(32);
    h.disk.set(ORPHAN, JSON.stringify({ version: 1, conversations: {}, outbox: [] }));
    h.disk.set(KEY, JSON.stringify({ version: 1, conversations: {}, outbox: [] }));
    await h.dms.start();
    expect([...h.disk.keys()]).toEqual([KEY]);
    expect(h.logs).toContainEqual({ event: 'dm-orphan-removed', data: { circle: ORPHAN.slice(0, 8) } });
    h.dms.stop();
  });

  it('doesn’t acknowledge a message to a conversation that has ended, so the sender keeps it', async () => {
    const h = harness(null as unknown as DirectPerson[]);
    h.disk.set(
      KEY,
      JSON.stringify({ version: 1, conversations: { [MAYA]: { peer: MAYA, name: 'Maya', ended: true, messages: [] } }, outbox: [] })
    );
    await h.dms.start();
    // Maya is back, but this device hasn't caught up with that yet.
    h.setPeopleQuietly([{ identity: MAYA, name: 'Maya', online: true }]);
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'Back', at: 1 });
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.sent).toEqual([]);
    expect((await h.dms.messages(KEY, MAYA)).messages).toEqual([]);
    h.dms.stop();
  });

  it('drops a signal from someone who isn’t a member, without storing or acknowledging it', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.receive(KEY, SAM, 'dm.message', { op: op(1), id: op(2), text: 'Hi', at: 1 });
    await h.dms.receive(KEY, SAM, 'dm.typing', {});
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect(h.disk.size).toBe(0);
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([]);
    h.dms.stop();
  });

  it('refuses a bad Circle key, person or message id, and keeps a page between 1 and 200', async () => {
    const h = harness();
    await h.dms.start();
    for (let i = 1; i <= 250; i += 1) await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1000 + i), id: op(2000 + i), text: `Hi ${i}`, at: i });
    expect((await h.dms.messages(KEY, MAYA, { limit: Number.NaN })).messages).toHaveLength(50);
    expect((await h.dms.messages(KEY, MAYA, { limit: 1e9 })).messages).toHaveLength(200);
    expect((await h.dms.messages(KEY, MAYA, { limit: -5 })).messages).toHaveLength(1);
    expect((await h.dms.messages(KEY, MAYA, { limit: 2.5 })).messages).toHaveLength(50);
    await expect(h.dms.messages(KEY, 'nope')).rejects.toThrow('isn’t a person');
    await expect(h.dms.messages('nope', MAYA)).rejects.toThrow('isn’t a Circle key');
    await expect(h.dms.messages(KEY, MAYA, { before: '../x' })).rejects.toThrow('isn’t a message id');
    await expect(h.dms.conversations('../x')).rejects.toThrow('isn’t a Circle key');
    await expect(h.dms.send(KEY, MAYA.toUpperCase(), 'Hi')).rejects.toThrow('isn’t a person');
    await expect(h.dms.edit(KEY, MAYA, 'nope', 'Hi')).rejects.toThrow('isn’t a message id');
    await expect(h.dms.delete(KEY, MAYA, 'nope')).rejects.toThrow('isn’t a message id');
    await expect(h.dms.markRead(KEY, MAYA, 'nope')).rejects.toThrow('isn’t a message id');
    h.dms.typing('nope', MAYA);
    expect(h.sent.filter((s) => s.topic === 'dm.typing')).toEqual([]);
    h.dms.stop();
  });

  it('saves times it capped on load, own messages included, so they stay put', async () => {
    const h = harness();
    const future = Date.now() + 1e9;
    const file: DirectFile = {
      version: 1,
      conversations: {
        [MAYA]: {
          peer: MAYA,
          name: 'Maya',
          ended: false,
          messages: [
            { id: op(2), author: MAYA, text: 'Hi', at: 8_640_000_000_000_001, edited: false, deleted: false },
            { id: op(3), author: ME, text: 'Clock ahead', at: future, edited: false, deleted: false, delivered: true },
          ],
        },
      },
      outbox: [],
    };
    h.disk.set(KEY, JSON.stringify(file));
    await h.dms.start();
    await settle();
    const saved = JSON.parse(h.disk.get(KEY)!) as DirectFile;
    expect(saved.conversations[MAYA]!.messages.map((m) => m.at)).toEqual([Date.now(), Date.now()]);
    h.dms.stop();
  });

  it('deletes a message whose first send is still being saved as never sent', async () => {
    const h = harness([{ identity: SAM, name: 'Sam', online: false }]);
    await h.dms.start();
    const { id } = await h.dms.send(KEY, SAM, 'Oops');
    // Sam connects: the message is marked sent and its save starts; the delete lands before it goes.
    const connecting = h.setPeople([{ identity: SAM, name: 'Sam', online: true }]);
    const deleting = h.dms.delete(KEY, SAM, id);
    await connecting;
    expect(await deleting).toEqual({ unsent: true });
    await settle();
    expect(h.sent).toEqual([]);
    expect(JSON.parse(h.disk.get(KEY)!).outbox).toEqual([]);
    h.dms.stop();
  });

  it('logs an orphan DM file it couldn’t remove as a failure, not as removed', async () => {
    const h = harness();
    const ORPHAN = 'ee'.repeat(32);
    h.disk.set(ORPHAN, JSON.stringify({ version: 1, conversations: {}, outbox: [] }));
    h.control.removeFails = true;
    await h.dms.start();
    expect(h.logs.map((l) => l.event)).toContain('dm-orphan-remove-failed');
    expect(h.logs.map((l) => l.event)).not.toContain('dm-orphan-removed');
    expect(h.logs.find((l) => l.event === 'dm-orphan-remove-failed')!.data).toEqual({ circle: ORPHAN.slice(0, 8) });
    h.dms.stop();
  });

  it('caps a future time at arrival and drops one past the Date range', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'From the future', at: Date.now() + 1e9 });
    expect((await h.dms.messages(KEY, MAYA)).messages[0]!.at).toBe(Date.now());
    expect(JSON.parse(h.disk.get(KEY)!).conversations[MAYA].messages[0].at).toBe(Date.now());
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(3), id: op(4), text: 'Past the range', at: 8_640_000_000_000_001 });
    await vi.advanceTimersByTimeAsync(DIRECT_ACK_DELAY_MS);
    expect((await h.dms.messages(KEY, MAYA)).messages).toHaveLength(1);
    expect(h.sent).toEqual([{ topic: 'dm.ack', to: MAYA, payload: { ids: [op(1)] } }]);
    h.dms.stop();
  });

  it('caps a stored time past now when it loads, so a file holding one recovers', async () => {
    const h = harness();
    const bad = 8_640_000_000_000_001;
    const file: DirectFile = {
      version: 1,
      conversations: {
        [MAYA]: {
          peer: MAYA,
          name: 'Maya',
          ended: false,
          messages: [{ id: op(2), author: MAYA, text: 'Hi', at: bad, edited: false, deleted: false }],
          read: { id: op(9), at: bad },
        },
      },
      outbox: [],
    };
    h.disk.set(KEY, JSON.stringify(file));
    await h.dms.start();
    expect((await h.dms.messages(KEY, MAYA)).messages[0]!.at).toBe(Date.now());
    expect((await h.dms.conversations(KEY))[0]!.last!.at).toBe(Date.now());
    h.dms.stop();
  });

  it('logs counts and timing only', async () => {
    const h = harness();
    await h.dms.start();
    await h.dms.send(KEY, MAYA, 'Secret plans');
    await h.dms.receive(KEY, MAYA, 'dm.ack', { ids: [h.sent[0]!.payload.op] });
    await h.dms.receive(KEY, MAYA, 'dm.message', { op: op(1), id: op(2), text: 'x', at: 'bad' });
    const text = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThan(2);
    // Circle keys as their first 8 hex characters; no full key or identity.
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(h.logs.every((entry) => entry.data.circle === undefined || entry.data.circle === KEY.slice(0, 8))).toBe(true);
    expect(text).not.toContain('Secret');
    expect(text).not.toContain(MAYA);
    expect(text).not.toContain(ME);
    h.dms.stop();
  });
});
