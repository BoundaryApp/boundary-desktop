/**
 * Direct messages in a Circle (ADR 0054): peer signals to one person, kept only on the two Macs.
 * Nothing here touches the Circle's log. The sender keeps an outbox until the other device
 * acknowledges each signal; the receiver dedupes by message id, so a resend is harmless.
 *
 * Storage, the network and the clock come in through `DirectDeps`, so this runs the same in
 * main and in tests.
 */
import type {
  CircleMessageRef,
  DirectConversation,
  DirectDelivery,
  DirectEvent,
  DirectMessage,
} from '../../../shared/types/circles';
import { MAX_DIRECT_TEXT_BYTES, directTextBytes } from '../../../shared/circleDirect';
import { MAX_SIGNAL_PAYLOAD_BYTES } from './circleSignals';
import { HEX_KEY_PATTERN } from '../../../shared/hexKeys';
import { MESSAGE_ID_PATTERN } from '../../../shared/circleReplies';

export const DIRECT_TOPICS = {
  message: 'dm.message',
  edit: 'dm.edit',
  delete: 'dm.delete',
  ack: 'dm.ack',
  typing: 'dm.typing',
} as const;

/** An unacknowledged signal goes again after this long while the other device is connected. */
export const DIRECT_RESEND_MS = 30_000;
/** How often the outbox is checked for signals due again. */
export const DIRECT_TICK_MS = 10_000;
/** Acknowledgements wait this long to share one signal. */
export const DIRECT_ACK_DELAY_MS = 250;
/** Most ids in one acknowledgement. */
export const MAX_ACK_IDS = 32;
/** Most unacknowledged signals in flight to one device, under the signal channel's 16-frame wait. */
export const DIRECT_SEND_BATCH = 10;
/** Typing goes at most this often per conversation. */
const TYPING_EVERY_MS = 3_000;
/** Messages per page when reading a conversation, and the most one read returns. */
const PAGE = 50;
const MAX_PAGE = 200;
/** Most edits and deletes kept per conversation for messages that haven't arrived yet. */
const MAX_EARLY = 200;
/** The longest `op`, so a payload is measured as it will go. */
const LONGEST_OP = 'f'.repeat(32);

/**
 * Whether a payload fits one signal once `op` is added. Text within `MAX_DIRECT_TEXT_BYTES` escaped
 * always does; this stays as a guard on the rest of the payload.
 */
const fitsSignal = (payload: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify({ ...payload, op: LONGEST_OP })) <= MAX_SIGNAL_PAYLOAD_BYTES;
const TOO_LONG = 'That message is too long to send directly.';

/** The latest time a `Date` can hold, in ms. A later `at` can't be shown, so it is dropped. */
const MAX_DATE_MS = 8.64e15;


const isDirectId = (id: unknown): id is string => typeof id === 'string' && MESSAGE_ID_PATTERN.test(id);

/** A Circle key as logs carry it: its first 8 hex characters. */
const short = (circleKey: string) => circleKey.slice(0, 8);

/** Throws unless the arguments from the renderer have the shapes of a Circle key, a person and message ids. */
function checkInput(circleKey: unknown, peer?: unknown, ...ids: unknown[]): void {
  if (typeof circleKey !== 'string' || !HEX_KEY_PATTERN.test(circleKey)) throw new Error('That isn’t a Circle key.');
  if (peer !== undefined && (typeof peer !== 'string' || !HEX_KEY_PATTERN.test(peer))) throw new Error('That isn’t a person in a Circle.');
  if (!ids.every(isDirectId)) throw new Error('That isn’t a message id.');
}

/** Text this Mac sends: non-empty after trimming and at most `MAX_DIRECT_TEXT_BYTES` once escaped. */
function isDirectText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && directTextBytes(text) <= MAX_DIRECT_TEXT_BYTES;
}

/**
 * Text this Mac takes: non-empty and at most `MAX_DIRECT_TEXT_BYTES` of raw UTF-8. Earlier builds
 * counted raw bytes, so what they sent can be longer once escaped; the signal limit still bounds it.
 */
function isReceivedText(text: unknown): text is string {
  return typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text) <= MAX_DIRECT_TEXT_BYTES;
}

type OutTopic = typeof DIRECT_TOPICS.message | typeof DIRECT_TOPICS.edit | typeof DIRECT_TOPICS.delete;

export type DirectPayload =
  | { topic: 'dm.message'; op: string; id: string; text: string; at: number; reply: CircleMessageRef | null }
  | { topic: 'dm.edit'; op: string; id: string; text: string }
  | { topic: 'dm.delete'; op: string; id: string }
  | { topic: 'dm.ack'; ids: string[] }
  | { topic: 'dm.typing' };

/** What a DM signal carries, or null when it doesn't have the right shape. The sender isn't trusted. */
export function directPayloadOf(topic: string, payload: unknown): DirectPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  switch (topic) {
    case DIRECT_TOPICS.typing:
      return { topic };
    case DIRECT_TOPICS.ack: {
      const ids = p.ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ACK_IDS || !ids.every(isDirectId)) return null;
      return { topic, ids: [...ids] };
    }
    case DIRECT_TOPICS.message: {
      if (!isDirectId(p.op) || !isDirectId(p.id) || !isReceivedText(p.text)) return null;
      if (!Number.isSafeInteger(p.at) || (p.at as number) < 0 || (p.at as number) > MAX_DATE_MS) return null;
      let reply: CircleMessageRef | null = null;
      if (p.reply !== undefined) {
        const { author, id } = (p.reply ?? {}) as { author?: unknown; id?: unknown };
        if (typeof author !== 'string' || !HEX_KEY_PATTERN.test(author) || !isDirectId(id)) return null;
        reply = { author, id };
      }
      return { topic, op: p.op, id: p.id, text: p.text, at: p.at as number, reply };
    }
    case DIRECT_TOPICS.edit:
      if (!isDirectId(p.op) || !isDirectId(p.id) || !isReceivedText(p.text)) return null;
      return { topic, op: p.op, id: p.id, text: p.text };
    case DIRECT_TOPICS.delete:
      if (!isDirectId(p.op) || !isDirectId(p.id)) return null;
      return { topic, op: p.op, id: p.id };
    default:
      return null;
  }
}

/** One message as this device keeps it. */
export interface StoredDirectMessage {
  id: string;
  author: string;
  text: string;
  at: number;
  reply?: CircleMessageRef;
  edited: boolean;
  deleted: boolean;
  /** This user's message reached the other device. Absent on messages from the other person. */
  delivered?: boolean;
}

export interface StoredConversation {
  peer: string;
  /** The other person's name when last seen as a member, kept after they leave. */
  name: string;
  ended: boolean;
  /** Oldest first. */
  messages: StoredDirectMessage[];
  /**
   * Edits and deletes that arrived before their message, by id. A resend of the message after
   * them must not bring back text its sender changed or deleted.
   */
  early?: Record<string, { text?: string; deleted?: true }>;
  /** The newest message this device has read, by id, with its time for when that message is gone. */
  read?: { id: string; at: number };
}

/** A signal waiting for the other device's acknowledgement. */
export interface OutboxItem {
  op: string;
  peer: string;
  topic: OutTopic;
  /** The message it concerns. */
  id: string;
  payload: Record<string, unknown>;
  /** It has gone to the other device at least once, so it can't be taken back unseen. */
  sent?: true;
}

/** Everything one Circle's DMs keep on this device. */
export interface DirectFile {
  version: 1;
  conversations: Record<string, StoredConversation>;
  /** In the order sent. */
  outbox: OutboxItem[];
}

export interface DirectPerson {
  identity: string;
  name: string;
  online: boolean;
}

export interface DirectDeps {
  identity(): string;
  /**
   * The Circle's other members, or null when this device can't say yet: the Circle isn't open,
   * or hasn't caught up, so someone missing may only be not yet replicated.
   */
  people(circleKey: string): DirectPerson[] | null;
  /** Whether this device's Circles store still has the Circle. A DM file for one it doesn't is left over. */
  known(circleKey: string): boolean;
  /** False when Circles isn't running, so nothing went. Throws on a payload the channel refuses. */
  send(circleKey: string, topic: string, payload: unknown, to: string): boolean;
  keys(): Promise<string[]>;
  load(circleKey: string): Promise<DirectFile | null>;
  save(circleKey: string, file: DirectFile): Promise<void>;
  remove(circleKey: string): Promise<void>;
  newId(): string;
  now(): number;
  emit(event: DirectEvent): void;
  /** Metadata only: counts, Circle keys and timing, never names, identities or text. */
  log(event: string, data: Record<string, unknown>): void;
}

const emptyFile = (): DirectFile => ({ version: 1, conversations: {}, outbox: [] });

/**
 * Bring any time later than `now` back to `now`, the user's own messages included. Files from
 * builds that stored the sender's time as it came can hold one past the Date range, which can't
 * be shown. Returns whether anything changed.
 */
function capTimes(file: DirectFile, now: number): boolean {
  let changed = false;
  for (const conversation of Object.values(file.conversations)) {
    for (const message of conversation.messages) {
      if (message.at <= now) continue;
      message.at = now;
      changed = true;
    }
    if (conversation.read && !(conversation.read.at <= now)) {
      conversation.read.at = now;
      changed = true;
    }
  }
  return changed;
}

/**
 * The index of the newest message read, or -1 when nothing is. A read message that is gone
 * (unsent by its sender) falls back to the last message no newer than its time.
 */
function readIndex(conversation: StoredConversation): number {
  const { read, messages } = conversation;
  if (!read) return -1;
  const exact = messages.findIndex((m) => m.id === read.id);
  if (exact !== -1) return exact;
  let index = -1;
  messages.forEach((m, i) => {
    if (m.at <= read.at) index = i;
  });
  return index;
}

export class DirectMessages {
  private readonly files = new Map<string, DirectFile>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** When each outbox signal last went, by op. Not kept: after a restart everything is due. */
  private readonly sentAt = new Map<string, number>();
  /** Outbox signals marked sent and waiting for that to be saved before they first go, by op. */
  private readonly firstSaving = new Set<string>();
  /** Who was online at the last snapshot, by `circle/peer`. */
  private readonly online = new Set<string>();
  private readonly acks = new Map<string, { ids: string[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly lastTyping = new Map<string, number>();
  /**
   * Circles this user left or was removed from, with whether a snapshot has since shown them gone.
   * Nothing is kept for them until they are back in the Circle after that.
   */
  private readonly forgotten = new Map<string, boolean>();
  private tick: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: DirectDeps) {}

  /** Load every Circle's DMs and start resending. */
  async start(): Promise<void> {
    this.stopped = false;
    for (const key of await this.deps.keys()) {
      if (!this.deps.known(key)) {
        // Left over from a leave or removal that didn't finish removing it.
        // A failure leaves the file for the next start to try again.
        const removed = await this.deps.remove(key).then(
          () => true,
          () => false
        );
        this.deps.log(removed ? 'dm-orphan-removed' : 'dm-orphan-remove-failed', { circle: short(key) });
        continue;
      }
      await this.serial(key, (): void => undefined).catch((): void => this.deps.log('dm-load-failed', { circle: short(key) }));
    }
    if (this.stopped) return;
    this.tick = setInterval(() => this.flushAll(), DIRECT_TICK_MS);
    await this.onPeopleChanged();
  }

  stop(): void {
    this.stopped = true;
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    for (const { timer } of this.acks.values()) clearTimeout(timer);
    this.acks.clear();
  }

  // ---- Reading ----

  async conversations(circleKey: string): Promise<DirectConversation[]> {
    checkInput(circleKey);
    return this.serial(circleKey, (file) =>
      Object.values(file.conversations)
        .filter((c) => c.messages.length > 0)
        .map((c) => this.conversationView(circleKey, file, c))
        .sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
    );
  }

  async messages(
    circleKey: string,
    peer: string,
    { before, limit = PAGE }: { before?: string; limit?: number } = {}
  ): Promise<{ messages: DirectMessage[]; more: boolean }> {
    checkInput(circleKey, peer, ...(before === undefined ? [] : [before]));
    const size = Number.isSafeInteger(limit) ? Math.min(MAX_PAGE, Math.max(1, limit)) : PAGE;
    return this.serial(circleKey, (file) => {
      const all = file.conversations[peer]?.messages ?? [];
      let end = all.length;
      if (before) {
        const index = all.findIndex((m) => m.id === before);
        if (index >= 0) end = index;
      }
      const start = Math.max(0, end - size);
      return { messages: all.slice(start, end).map((m) => this.view(circleKey, file, peer, m)), more: start > 0 };
    });
  }

  // ---- Sending ----

  async send(circleKey: string, peer: string, text: string, reply?: CircleMessageRef): Promise<{ id: string }> {
    checkInput(circleKey, peer);
    if (reply) checkInput(circleKey, reply.author, reply.id);
    if (!isDirectText(text)) throw new Error(`A direct message is at most ${MAX_DIRECT_TEXT_BYTES} bytes and can’t be empty.`);
    const person = this.member(circleKey, peer);
    return this.serial(
      circleKey,
      (file) => {
        const conversation = this.conversation(file, peer, person.name);
        if (conversation.ended) throw new Error('This conversation has ended.');
        if (reply && !conversation.messages.some((m) => m.author === reply.author && m.id === reply.id)) {
          throw new Error('That message isn’t in this conversation.');
        }
        const id = this.deps.newId();
        const at = this.deps.now();
        const payload = { id, text, at, ...(reply ? { reply: { author: reply.author, id: reply.id } } : {}) };
        if (!fitsSignal(payload)) throw new Error(TOO_LONG);
        const message: StoredDirectMessage = {
          id,
          author: this.deps.identity(),
          text,
          at,
          ...(reply ? { reply: { author: reply.author, id: reply.id } } : {}),
          edited: false,
          deleted: false,
          delivered: false,
        };
        conversation.messages.push(message);
        file.outbox.push({
          op: this.deps.newId(),
          peer,
          topic: DIRECT_TOPICS.message,
          id,
          payload,
        });
        this.changed(circleKey, file, peer, message);
        this.deps.log('dm-queued', { circle: short(circleKey), outbox: file.outbox.length });
        return { id, sending: this.flush(circleKey, file, peer) };
      },
      true
    ).then(async ({ id, sending }) => {
      await sending;
      return { id };
    });
  }

  /** Only the sender edits. An edit to a message not yet sent changes what will be sent. */
  async edit(circleKey: string, peer: string, id: string, text: string): Promise<void> {
    checkInput(circleKey, peer, id);
    if (!isDirectText(text)) throw new Error(`A direct message is at most ${MAX_DIRECT_TEXT_BYTES} bytes and can’t be empty.`);
    const sending = await this.serial(
      circleKey,
      (file) => {
        const message = this.own(file, peer, id);
        if (message.text === text) return null;
        const unsent = file.outbox.find((item) => item.peer === peer && item.id === id && !item.sent);
        const folds = unsent?.topic === DIRECT_TOPICS.message || unsent?.topic === DIRECT_TOPICS.edit;
        const payload = folds ? { ...unsent!.payload, text } : { id, text };
        if (!fitsSignal(payload)) throw new Error(TOO_LONG);
        message.text = text;
        // Folded into a message that hasn't gone, the other person never sees the earlier text.
        if (unsent?.topic !== DIRECT_TOPICS.message) message.edited = true;
        if (folds) unsent!.payload = payload;
        else file.outbox.push({ op: this.deps.newId(), peer, topic: DIRECT_TOPICS.edit, id, payload });
        this.changed(circleKey, file, peer, message);
        return { done: this.flush(circleKey, file, peer) };
      },
      true
    );
    await sending?.done;
  }

  /**
   * Only the sender deletes. A message that was never sent leaves the conversation and the
   * outbox and is never sent; otherwise a delete goes through the outbox. Returns whether it
   * was never sent.
   */
  async delete(circleKey: string, peer: string, id: string): Promise<{ unsent: boolean }> {
    checkInput(circleKey, peer, id);
    const { unsent, sending } = await this.serial(
      circleKey,
      (file) => {
        const message = this.own(file, peer, id);
        const mine = (item: OutboxItem) => item.peer === peer && item.id === id;
        // A first send whose save is still running hasn't gone yet either.
        const neverSent = file.outbox.some(
          (item) => mine(item) && item.topic === DIRECT_TOPICS.message && (!item.sent || this.firstSaving.has(item.op))
        );
        if (neverSent) {
          file.outbox = file.outbox.filter((item) => !mine(item));
          const conversation = file.conversations[peer]!;
          conversation.messages = conversation.messages.filter((m) => m !== message);
          this.deps.emit({ kind: 'unsent', circleKey, peer, id });
          return { unsent: true, sending: null };
        }
        // Edits not yet sent are moot once the message goes.
        file.outbox = file.outbox.filter((item) => !(mine(item) && item.topic === DIRECT_TOPICS.edit && !item.sent));
        file.outbox.push({ op: this.deps.newId(), peer, topic: DIRECT_TOPICS.delete, id, payload: { id } });
        message.text = '';
        message.deleted = true;
        delete message.reply;
        this.changed(circleKey, file, peer, message);
        return { unsent: false, sending: this.flush(circleKey, file, peer) };
      },
      true
    );
    await sending;
    return { unsent };
  }

  /** This device has read the conversation up to `id`, a message in it. Moves forward only. */
  async markRead(circleKey: string, peer: string, id: string): Promise<void> {
    checkInput(circleKey, peer, id);
    await this.serial(
      circleKey,
      (file) => {
        const conversation = file.conversations[peer];
        const index = conversation?.messages.findIndex((m) => m.id === id) ?? -1;
        if (!conversation || index === -1) throw new Error('That message isn’t in this conversation.');
        if (index < readIndex(conversation)) return;
        const message = conversation.messages[index]!;
        if (conversation.read?.id === message.id) return;
        conversation.read = { id: message.id, at: message.at };
        this.deps.emit({ kind: 'read', circleKey, peer });
      },
      true
    );
  }

  typing(circleKey: string, peer: string): void {
    if (!HEX_KEY_PATTERN.test(circleKey) || !HEX_KEY_PATTERN.test(peer)) return;
    const key = `${circleKey}/${peer}`;
    const now = this.deps.now();
    if (now - (this.lastTyping.get(key) ?? -Infinity) < TYPING_EVERY_MS) return;
    const person = this.deps.people(circleKey)?.find((p) => p.identity === peer);
    if (!person?.online) return;
    this.lastTyping.set(key, now);
    this.deps.send(circleKey, DIRECT_TOPICS.typing, {}, peer);
  }

  // ---- Receiving ----

  /** A DM signal from `from`, a current member of the Circle as the network process checked. */
  receive(circleKey: string, from: string, topic: string, raw: unknown): Promise<void> {
    const payload = directPayloadOf(topic, raw);
    if (!payload) {
      this.deps.log('dm-dropped', { circle: short(circleKey), topic });
      return Promise.resolve();
    }
    const people = this.deps.people(circleKey);
    if (!people || this.forgotten.has(circleKey)) {
      // Left, or not caught up yet: nothing is stored or acknowledged, so the sender tries again later.
      this.deps.log('dm-not-open', { circle: short(circleKey), topic });
      return Promise.resolve();
    }
    const sender = people.find((p) => p.identity === from);
    if (!sender) {
      this.deps.log('dm-not-member', { circle: short(circleKey), topic });
      return Promise.resolve();
    }
    if (payload.topic === DIRECT_TOPICS.typing) {
      this.deps.emit({ kind: 'typing', circleKey, peer: from });
      return Promise.resolve();
    }
    return this.serial(
      circleKey,
      (file): { op: string | null; sending?: Promise<void> } => {
        if (payload.topic === DIRECT_TOPICS.ack) return { op: null, sending: this.onAck(circleKey, file, from, payload.ids) };
        const conversation = this.conversation(file, from, sender.name);
        const existing = conversation.messages.find((m) => m.author === from && m.id === payload.id);
        if (payload.topic === DIRECT_TOPICS.message) {
          // Not acknowledged, so the sender keeps it until this device sees the conversation carry on.
          if (!existing && conversation.ended) return { op: null };
          if (!existing) {
            const early = conversation.early?.[payload.id];
            if (early) delete conversation.early![payload.id];
            const message: StoredDirectMessage = {
              id: payload.id,
              author: from,
              text: early?.deleted ? '' : (early?.text ?? payload.text),
              // The sender's clock, never later than this one's, so a skewed clock can't pin it first.
              at: Math.min(payload.at, this.deps.now()),
              ...(payload.reply && !early?.deleted ? { reply: payload.reply } : {}),
              edited: early?.text !== undefined,
              deleted: early?.deleted === true,
            };
            conversation.messages.push(message);
            this.deps.emit({ kind: 'message', circleKey, peer: from, message: this.view(circleKey, file, from, message) });
          }
        } else if (existing && !existing.deleted) {
          if (payload.topic === DIRECT_TOPICS.edit) {
            existing.text = payload.text;
            existing.edited = true;
          } else {
            existing.text = '';
            existing.deleted = true;
            delete existing.reply;
          }
          this.changed(circleKey, file, from, existing);
        } else if (!existing) {
          // The message itself may still be on its way.
          const early = (conversation.early ??= {});
          const keys = Object.keys(early);
          if (keys.length >= MAX_EARLY) delete early[keys[0]!];
          early[payload.id] = payload.topic === DIRECT_TOPICS.delete ? { deleted: true } : { ...early[payload.id], text: payload.text };
        }
        // Acknowledged even when it was already here or no longer exists, so the sender stops.
        return { op: payload.op };
      },
      true
    ).then(async ({ op, sending }) => {
      // Only once stored: a crash before the save leaves the sender to send it again.
      if (op) this.acknowledge(circleKey, from, op);
      await sending;
    });
  }

  // ---- Membership ----

  /**
   * Call when the Circles snapshot changes: people came online, left or were removed. Resolves
   * once what this sent for devices that connected has gone; it never rejects.
   */
  onPeopleChanged(): Promise<void> {
    const sending: Promise<void>[] = [];
    for (const [circleKey, seenGone] of this.forgotten) {
      if (!this.deps.people(circleKey)) this.forgotten.set(circleKey, true);
      else if (seenGone) this.forgotten.delete(circleKey);
    }
    for (const [circleKey, file] of this.files) {
      const people = this.deps.people(circleKey);
      if (!people) continue;
      const now = new Set(people.filter((p) => p.online).map((p) => `${circleKey}/${p.identity}`));
      const members = new Set(people.map((p) => p.identity));
      let changed = false;
      for (const conversation of Object.values(file.conversations)) {
        const person = people.find((p) => p.identity === conversation.peer);
        if (person) conversation.name = person.name;
        if (person && conversation.ended) {
          // Back in the Circle with the same identity: the conversation carries on.
          conversation.ended = false;
          changed = true;
          this.deps.emit({ kind: 'reopened', circleKey, peer: conversation.peer });
        }
        if (!members.has(conversation.peer) && !conversation.ended) {
          conversation.ended = true;
          file.outbox = file.outbox.filter((item) => item.peer !== conversation.peer);
          changed = true;
          this.deps.emit({ kind: 'ended', circleKey, peer: conversation.peer });
        }
      }
      if (changed) void this.serial(circleKey, (): void => undefined, true);
      for (const key of now) {
        if (this.online.has(key)) continue;
        const peer = key.slice(circleKey.length + 1);
        // Everything for a device that has just connected goes again.
        for (const item of file.outbox) if (item.peer === peer) this.sentAt.delete(item.op);
        sending.push(this.flush(circleKey, file, peer));
        this.emitDelivery(circleKey, file, peer);
      }
      for (const key of [...this.online]) {
        if (!key.startsWith(`${circleKey}/`) || now.has(key)) continue;
        this.online.delete(key);
        this.emitDelivery(circleKey, file, key.slice(circleKey.length + 1));
      }
      for (const key of now) this.online.add(key);
    }
    return Promise.all(sending).then((): void => undefined);
  }

  /** This user left the Circle, or was removed: its DMs leave this Mac. */
  async forget(circleKey: string): Promise<void> {
    // Before the queue: work already queued, or a signal arriving before the snapshot drops the Circle, saves nothing.
    this.forgotten.set(circleKey, false);
    // In the Circle's queue, so work queued before it can't save the file back afterwards.
    await this.serial(circleKey, async (file) => {
      for (const item of file.outbox) {
        this.sentAt.delete(item.op);
        this.firstSaving.delete(item.op);
      }
      this.files.delete(circleKey);
      for (const key of [...this.online]) if (key.startsWith(`${circleKey}/`)) this.online.delete(key);
      for (const [key, pending] of this.acks) {
        if (!key.startsWith(`${circleKey}/`)) continue;
        clearTimeout(pending.timer);
        this.acks.delete(key);
      }
      await this.deps.remove(circleKey);
    }).catch(() => this.deps.remove(circleKey));
    this.deps.log('dm-forgotten', { circle: short(circleKey) });
  }

  // ---- Internals ----

  /** Run `work` on the Circle's file, one at a time per Circle; `save` writes it afterwards. */
  private serial<T>(circleKey: string, work: (file: DirectFile) => T | Promise<T>, save = false): Promise<T> {
    const previous = this.queues.get(circleKey) ?? Promise.resolve();
    const next = previous
      .catch((): void => undefined)
      .then(async () => {
        let file = this.files.get(circleKey);
        if (!file) {
          file = (await this.deps.load(circleKey)) ?? emptyFile();
          const capped = capTimes(file, this.deps.now());
          if (!this.forgotten.has(circleKey)) {
            this.files.set(circleKey, file);
            // Saved, so a capped time stays put instead of moving to each launch's load time.
            if (capped) void this.serial(circleKey, (): void => undefined, true).catch((): void => undefined);
          }
        }
        const result = await work(file);
        if (save && this.files.get(circleKey) === file) await this.deps.save(circleKey, file);
        return result;
      });
    this.queues.set(circleKey, next);
    return next;
  }

  private member(circleKey: string, peer: string): DirectPerson {
    if (peer === this.deps.identity()) throw new Error('That is you.');
    const people = this.deps.people(circleKey);
    if (!people || this.forgotten.has(circleKey)) throw new Error('That Circle isn’t open on this Mac.');
    const person = people.find((p) => p.identity === peer);
    if (!person) throw new Error('They aren’t in this Circle.');
    return person;
  }

  private conversation(file: DirectFile, peer: string, name: string): StoredConversation {
    let conversation = file.conversations[peer];
    if (!conversation) {
      conversation = { peer, name, ended: false, messages: [] };
      file.conversations[peer] = conversation;
    }
    return conversation;
  }

  private own(file: DirectFile, peer: string, id: string): StoredDirectMessage {
    const conversation = file.conversations[peer];
    if (conversation?.ended) throw new Error('This conversation has ended.');
    const message = conversation?.messages.find((m) => m.id === id && m.author === this.deps.identity());
    if (!message) throw new Error('That message isn’t yours.');
    if (message.deleted) throw new Error('That message was deleted.');
    return message;
  }

  private isOnline(circleKey: string, peer: string): boolean {
    return this.deps.people(circleKey)?.some((p) => p.identity === peer && p.online) ?? false;
  }

  private delivery(circleKey: string, file: DirectFile, peer: string, message: StoredDirectMessage): DirectDelivery | null {
    if (message.author !== this.deps.identity()) return null;
    if (message.delivered) return 'delivered';
    const pending = file.outbox.some((item) => item.peer === peer && item.id === message.id && item.topic === DIRECT_TOPICS.message);
    // Dropped from the outbox unacknowledged: the conversation ended first.
    if (!pending) return 'undelivered';
    return this.isOnline(circleKey, peer) ? 'sending' : 'waiting';
  }

  private view(circleKey: string, file: DirectFile, peer: string, message: StoredDirectMessage): DirectMessage {
    return {
      id: message.id,
      author: message.author,
      mine: message.author === this.deps.identity(),
      text: message.text,
      at: message.at,
      reply: message.reply ?? null,
      edited: message.edited,
      deleted: message.deleted,
      delivery: this.delivery(circleKey, file, peer, message),
      neverSent: file.outbox.some(
        (item) => item.peer === peer && item.id === message.id && item.topic === DIRECT_TOPICS.message && !item.sent
      ),
    };
  }

  private conversationView(circleKey: string, file: DirectFile, c: StoredConversation): DirectConversation {
    const last = c.messages[c.messages.length - 1];
    const me = this.deps.identity();
    return {
      peer: c.peer,
      name: c.name,
      online: !c.ended && this.isOnline(circleKey, c.peer),
      ended: c.ended,
      last: last ? { at: last.at, text: last.text, mine: last.author === me, deleted: last.deleted } : null,
      waiting: file.outbox.filter((item) => item.peer === c.peer && item.topic === DIRECT_TOPICS.message).length,
      unread: c.messages.slice(readIndex(c) + 1).filter((m) => m.author === c.peer && !m.deleted).length,
    };
  }

  private changed(circleKey: string, file: DirectFile, peer: string, message: StoredDirectMessage): void {
    this.deps.emit({ kind: 'change', circleKey, peer, message: this.view(circleKey, file, peer, message) });
  }

  /** Waiting turns to sending, or back, when the other device connects or goes. */
  private emitDelivery(circleKey: string, file: DirectFile, peer: string): void {
    const conversation = file.conversations[peer];
    if (!conversation) return;
    for (const item of file.outbox) {
      if (item.peer !== peer || item.topic !== DIRECT_TOPICS.message) continue;
      const message = conversation.messages.find((m) => m.id === item.id);
      if (message) this.changed(circleKey, file, peer, message);
    }
  }

  /**
   * Send what is due to `peer`, keeping at most `DIRECT_SEND_BATCH` unacknowledged in flight. A
   * signal going for the first time is saved as sent before it goes, so a crash after it went
   * can't leave a delete calling it never sent. Resolves once those first sends are done; it never
   * rejects.
   */
  private flush(circleKey: string, file: DirectFile, peer: string): Promise<void> {
    if (!this.isOnline(circleKey, peer)) return Promise.resolve();
    const now = this.deps.now();
    const items = file.outbox.filter((item) => item.peer === peer);
    const waiting = (item: OutboxItem) => {
      if (this.firstSaving.has(item.op)) return true;
      const at = this.sentAt.get(item.op);
      return at !== undefined && now - at < DIRECT_RESEND_MS;
    };
    let inFlight = items.filter(waiting).length;
    let sent = 0;
    const first: OutboxItem[] = [];
    for (const item of items) {
      if (inFlight >= DIRECT_SEND_BATCH) break;
      if (waiting(item)) continue;
      if (!item.sent) {
        item.sent = true;
        this.firstSaving.add(item.op);
        first.push(item);
        inFlight += 1;
        continue;
      }
      const result = this.transmit(circleKey, item, peer);
      if (result === 'down') break;
      if (result === 'failed') continue;
      this.sentAt.set(item.op, now);
      inFlight += 1;
      sent += 1;
    }
    if (sent > 0) this.deps.log('dm-sent', { circle: short(circleKey), sent, outbox: file.outbox.length });
    return first.length > 0 ? this.sendFirst(circleKey, file, peer, first) : Promise.resolve();
  }

  /** Save `items` as sent, then send them; any that didn't go is marked unsent again. */
  private async sendFirst(circleKey: string, file: DirectFile, peer: string, items: OutboxItem[]): Promise<void> {
    let saved = true;
    await this.serial(circleKey, (): void => undefined, true).catch(() => {
      saved = false;
    });
    try {
      const reverted = await this.serial(circleKey, (current) => {
        let back = false;
        let down = !saved;
        let sent = 0;
        for (const item of items) {
          this.firstSaving.delete(item.op);
          if (current !== file || !file.outbox.includes(item)) continue;
          const result = down || !this.isOnline(circleKey, peer) ? 'down' : this.transmit(circleKey, item, peer);
          if (result === 'sent') {
            this.sentAt.set(item.op, this.deps.now());
            sent += 1;
            continue;
          }
          if (result === 'down') down = true;
          // It didn't go, so it is still never sent.
          delete item.sent;
          back = true;
        }
        if (sent > 0) this.deps.log('dm-sent', { circle: short(circleKey), sent, outbox: file.outbox.length });
        return back;
      });
      if (reverted) await this.serial(circleKey, (): void => undefined, true);
    } catch {
      this.deps.log('dm-save-failed', { circle: short(circleKey) });
    }
  }

  /** One outbox signal to `peer`: whether it went, threw, or Circles isn't running. */
  private transmit(circleKey: string, item: OutboxItem, peer: string): 'sent' | 'failed' | 'down' {
    try {
      return this.deps.send(circleKey, item.topic, { ...item.payload, op: item.op }, peer) ? 'sent' : 'down';
    } catch {
      // Kept in the outbox; the next flush tries again.
      this.deps.log('dm-send-failed', { circle: short(circleKey), topic: item.topic });
      return 'failed';
    }
  }

  private flushAll(): void {
    for (const [circleKey, file] of this.files) {
      const peers = new Set(file.outbox.map((item) => item.peer));
      for (const peer of peers) void this.flush(circleKey, file, peer);
    }
  }

  private onAck(circleKey: string, file: DirectFile, from: string, ids: string[]): Promise<void> {
    const acked = new Set(ids);
    const done = file.outbox.filter((item) => item.peer === from && acked.has(item.op));
    if (done.length === 0) return Promise.resolve();
    file.outbox = file.outbox.filter((item) => !done.includes(item));
    const conversation = file.conversations[from];
    for (const item of done) {
      const at = this.sentAt.get(item.op);
      this.sentAt.delete(item.op);
      this.deps.log('dm-acked', { circle: short(circleKey), ms: at === undefined ? null : this.deps.now() - at });
      if (item.topic !== DIRECT_TOPICS.message) continue;
      const message = conversation?.messages.find((m) => m.id === item.id);
      if (!message) continue;
      message.delivered = true;
      this.changed(circleKey, file, from, message);
    }
    return this.flush(circleKey, file, from);
  }

  private acknowledge(circleKey: string, to: string, op: string): void {
    const key = `${circleKey}/${to}`;
    const send = () => {
      const pending = this.acks.get(key);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.acks.delete(key);
      this.deps.send(circleKey, DIRECT_TOPICS.ack, { ids: pending.ids }, to);
    };
    const pending = this.acks.get(key) ?? { ids: [], timer: setTimeout(send, DIRECT_ACK_DELAY_MS) };
    this.acks.set(key, pending);
    if (!pending.ids.includes(op)) pending.ids.push(op);
    if (pending.ids.length >= MAX_ACK_IDS) send();
  }
}
