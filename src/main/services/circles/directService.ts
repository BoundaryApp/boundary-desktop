/**
 * Main's direct messages (ADR 0054): `DirectMessages` connected to the Circles service's peer
 * signals and snapshots, and to this Mac's encrypted DM files. Functions answer with
 * `CirclesResult`, like the channel functions.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import { persistDebugLog } from '../../persistDebugLog';
import type {
  CircleMessageRef,
  CirclesResult,
  DirectConversation,
  DirectEvent,
  DirectMessage,
} from '../../../shared/types/circles';
import {
  circlesResult,
  getCirclesState,
  onCircleLeaving,
  onCircleRemoved,
  onCircleSignal,
  notifyDirect,
  onCirclesSnapshot,
  sendCircleSignal,
} from './circlesService';
import { short } from './circlesDiagnostics';
import { circlesKeptByWipe } from './circlesStore';
import { DIRECT_TOPICS, DirectMessages, type DirectPerson } from './directMessages';
import { directStore } from './directStore';

const handlers = new Set<(event: DirectEvent) => void>();

/** The Circle's other members, or null while it isn't open and caught up on this device. */
function people(circleKey: string): DirectPerson[] | null {
  const circle = getCirclesState().snapshot.circles.find((candidate) => candidate.key === circleKey);
  if (!circle || circle.myRole === null || !circle.writable) return null;
  return circle.members.filter((member) => !member.isMe).map(({ identity, name, online }) => ({ identity, name, online }));
}

let opened: ReturnType<typeof directStore> | null = null;
const store = () => (opened ??= directStore(path.join(app.getPath('userData'), 'circle-direct')));

const dms = new DirectMessages({
  identity: () => getCirclesState().snapshot.identity,
  people,
  known: (circleKey) => circlesKeptByWipe().has(circleKey),
  send: (circleKey, topic, payload, to) => sendCircleSignal(circleKey, topic, payload, to),
  keys: () => store().keys(),
  load: (circleKey) => store().load(circleKey),
  save: (circleKey, file) => store().save(circleKey, file),
  remove: (circleKey) => store().remove(circleKey),
  newId: () => randomBytes(8).toString('hex'),
  now: () => Date.now(),
  emit: (event) => {
    if ((event.kind === 'message' || event.kind === 'change') && !event.message.mine) {
      const name = people(event.circleKey)?.find((person) => person.identity === event.peer)?.name ?? '';
      notifyDirect(event.circleKey, event.peer, name, event.message, event.kind === 'message' ? 'new' : 'change');
    }
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        persistDebugLog('circles', 'dm handler failed', { kind: event.kind });
      }
    }
  },
  log: (event, data) => persistDebugLog('circles', event, data),
});

/** Receive DMs, resend the outbox, and forget a Circle's DMs when this user leaves it. */
export function listenForDirectMessages(): () => void {
  const stops = [
    ...Object.values(DIRECT_TOPICS).map((topic) =>
      onCircleSignal(topic, ({ circleKey, fromIdentity, payload }) => {
        void dms.receive(circleKey, fromIdentity, topic, payload).catch(() =>
          persistDebugLog('circles', 'dm-receive-failed', { circle: short(circleKey), topic })
        );
      })
    ),
    onCirclesSnapshot(() => void dms.onPeopleChanged()),
    onCircleLeaving((key) => void dms.forget(key)),
    onCircleRemoved((key) => void dms.forget(key)),
  ];
  void dms.start();
  return () => {
    dms.stop();
    stops.forEach((stop) => stop());
  };
}

/** This user's conversations in a Circle, most recent first. */
export function listDirectConversations(circleKey: string): Promise<CirclesResult<{ conversations: DirectConversation[] }>> {
  return circlesResult(async () => ({ conversations: await dms.conversations(circleKey) }));
}

/** The newest messages with one person, or those before `before`, oldest first. */
export function getDirectMessages(
  circleKey: string,
  peer: string,
  options: { before?: string; limit?: number } = {}
): Promise<CirclesResult<{ messages: DirectMessage[]; more: boolean }>> {
  return circlesResult(() => dms.messages(circleKey, peer, options));
}

export function sendDirectMessage(
  circleKey: string,
  peer: string,
  text: string,
  opts: { reply?: CircleMessageRef } = {}
): Promise<CirclesResult<{ id: string }>> {
  return circlesResult(() => dms.send(circleKey, peer, text, opts.reply));
}

export function editDirectMessage(circleKey: string, peer: string, id: string, text: string): Promise<CirclesResult> {
  return circlesResult(async () => {
    await dms.edit(circleKey, peer, id, text);
    return {};
  });
}

/** `unsent` is true when the message never left this Mac. */
export function deleteDirectMessage(circleKey: string, peer: string, id: string): Promise<CirclesResult<{ unsent: boolean }>> {
  return circlesResult(() => dms.delete(circleKey, peer, id));
}

/** Mark a conversation read on this device up to message `id`. */
export function markDirectRead(circleKey: string, peer: string, id: string): Promise<CirclesResult> {
  return circlesResult(async () => {
    await dms.markRead(circleKey, peer, id);
    return {};
  });
}

export function sendDirectTyping(circleKey: string, peer: string): void {
  dms.typing(circleKey, peer);
}

/** Every DM event: arrivals, changes, unsent deletes, typing and ended conversations. */
export function onDirectEvent(handler: (event: DirectEvent) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
