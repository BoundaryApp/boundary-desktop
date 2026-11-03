/**
 * Typing and read marks in Circle chats (ADR 0042 §8): peer signals that nothing keeps, so a
 * member offline at the time never sees them. Main limits how often this device sends them and
 * checks what arrives before the renderer sees it.
 */
import type { CircleChatMark, CircleMessageRef } from '../../../shared/types/circles';
import { isMessageId, isRecordName } from './circleOps';
import { onCircleSignal, sendCircleSignal } from './circlesService';
import { broadcast } from '../windows';

const TYPING_TOPIC = 'chat.typing';
const READ_TOPIC = 'chat.read';
/** Circle chats spec phase 4. */
const TYPING_EVERY_MS = 3_000;
const READ_EVERY_MS = 1_000;
const HEX_KEY = /^[0-9a-f]{64}$/;

const lastTyping = new Map<string, number>();
const lastRead = new Map<string, number>();
const laterRead = new Map<string, { timer: ReturnType<typeof setTimeout>; ref: CircleMessageRef }>();

/** Tell the Circle this user is typing in a channel; repeats inside 3 seconds are dropped. */
export function sendTyping(circleKey: string, channel: string, now = Date.now()): void {
  if (!isRecordName(channel)) return;
  const key = `${circleKey}/${channel}`;
  if (now - (lastTyping.get(key) ?? -Infinity) < TYPING_EVERY_MS) return;
  lastTyping.set(key, now);
  sendCircleSignal(circleKey, TYPING_TOPIC, { channel });
}

/**
 * Tell the Circle the newest message this user has read in a channel. At most one a second
 * goes out; a read inside that second goes when it ends, so the last one always arrives.
 */
export function sendRead(circleKey: string, channel: string, ref: CircleMessageRef, now = Date.now()): void {
  if (!isRecordName(channel) || !isMessageId(ref.id)) return;
  const key = `${circleKey}/${channel}`;
  const send = (at: number, read: CircleMessageRef) => {
    lastRead.set(key, at);
    sendCircleSignal(circleKey, READ_TOPIC, { channel, author: read.author, id: read.id });
  };
  const waited = now - (lastRead.get(key) ?? -Infinity);
  const pending = laterRead.get(key);
  if (waited >= READ_EVERY_MS && !pending) {
    send(now, ref);
    return;
  }
  if (pending) {
    pending.ref = ref;
    return;
  }
  const timer = setTimeout(() => {
    const due = laterRead.get(key);
    laterRead.delete(key);
    if (due) send(Date.now(), due.ref);
  }, READ_EVERY_MS - waited);
  laterRead.set(key, { timer, ref });
}

/** A typing or read signal's payload, or null when it doesn't have the right shape. */
export function presenceOf(topic: string, payload: unknown): CircleChatMark | null {
  const { channel, author, id } = (payload ?? {}) as { channel?: unknown; author?: unknown; id?: unknown };
  if (!isRecordName(channel)) return null;
  if (topic === TYPING_TOPIC) return { channel, kind: 'typing' };
  if (typeof author !== 'string' || !HEX_KEY.test(author) || !isMessageId(id)) return null;
  return { channel, kind: 'read', ref: { author, id } };
}

/** Pass members' typing and read marks to the renderer on `circles:chat-presence`. */
export function listenForChatSignals(): () => void {
  const forward = (topic: string) =>
    onCircleSignal(topic, ({ circleKey, fromIdentity, payload }) => {
      const presence = presenceOf(topic, payload);
      if (presence) broadcast('circles:chat-presence', { circleKey, from: fromIdentity, ...presence });
    });
  const stops = [forward(TYPING_TOPIC), forward(READ_TOPIC)];
  return () => stops.forEach((stop) => stop());
}

/** For tests: forget what was sent. */
export function resetChatSignalsForTests(): void {
  for (const { timer } of laterRead.values()) clearTimeout(timer);
  lastTyping.clear();
  lastRead.clear();
  laterRead.clear();
}
