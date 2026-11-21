import { useSyncExternalStore } from 'react';
import { createValueStore } from '../../lib/valueStore';

// Messages typed while an agent replies, waiting to be sent (run-control spec, Phase 2).
// Hermes's own queue can't be listed or edited, and Stop wipes it, so Boundary keeps the
// queue. It lives at module level, above any runtime mount, keyed by chat id: switching
// chats keeps each chat's queue, and the open chat drains its own (decision 2). Not saved
// across restarts. A new chat has no id until its first send resolves, so it queues under
// '' and moves to its id with rekeyRunQueue.

export interface QueuedPrompt {
  id: string;
  text: string;
  /** A writing voice chip on the message (ADR 0056 §8): it is sent with it when it drains. */
  voiceId?: string;
}

export interface RunQueue {
  items: QueuedPrompt[];
  /** Stop pauses the queue; nothing drains until the user sends from it or resumes it. */
  paused: boolean;
}

const EMPTY: RunQueue = { items: [], paused: false };
const queues = createValueStore<ReadonlyMap<string, RunQueue>>(new Map());

function write(key: string, next: RunQueue): void {
  const map = new Map(queues.get());
  // An empty queue has nothing to pause; dropping it means the next one starts unpaused.
  if (next.items.length === 0) map.delete(key);
  else map.set(key, next);
  queues.set(map);
}

export function getRunQueue(key: string): RunQueue {
  return queues.get().get(key) ?? EMPTY;
}

export function enqueuePrompt(key: string, text: string, voiceId?: string | null): QueuedPrompt | null {
  if (!text.trim()) return null;
  const item: QueuedPrompt = { id: crypto.randomUUID(), text, ...(voiceId ? { voiceId } : {}) };
  const queue = getRunQueue(key);
  write(key, { ...queue, items: [...queue.items, item] });
  return item;
}

export function removeQueuedPrompt(key: string, id: string): void {
  takeQueuedPrompt(key, id);
}

/** Removes one prompt (Edit, Send now on a chip) and returns it. */
export function takeQueuedPrompt(key: string, id: string): QueuedPrompt | null {
  const queue = getRunQueue(key);
  const item = queue.items.find((i) => i.id === id) ?? null;
  if (item) write(key, { ...queue, items: queue.items.filter((i) => i.id !== id) });
  return item;
}

/** Removes and returns the head, the next prompt to send. */
export function shiftQueuedPrompt(key: string): QueuedPrompt | null {
  const head = getRunQueue(key).items[0];
  return head ? takeQueuedPrompt(key, head.id) : null;
}

export function pauseRunQueue(key: string): void {
  const queue = getRunQueue(key);
  if (queue.items.length === 0 || queue.paused) return;
  write(key, { ...queue, paused: true });
}

export function resumeRunQueue(key: string): void {
  const queue = getRunQueue(key);
  if (!queue.paused) return;
  write(key, { ...queue, paused: false });
}

/** A new chat got its id: its queue follows, after anything already queued there. */
export function rekeyRunQueue(from: string, to: string): void {
  if (from === to) return;
  const moving = queues.get().get(from);
  if (!moving) return;
  const there = getRunQueue(to);
  const map = new Map(queues.get());
  map.delete(from);
  map.set(to, { items: [...there.items, ...moving.items], paused: there.paused || moving.paused });
  queues.set(map);
}

export function queueChipLabel(index: number, paused: boolean): string {
  if (paused) return 'Paused';
  return index === 0 ? 'Next' : `Queued ${index + 1}`;
}

export function useRunQueue(key: string): RunQueue {
  return useSyncExternalStore(queues.subscribe, () => getRunQueue(key));
}

/** @internal Vitest only. */
export function clearRunQueuesForTests(): void {
  queues.set(new Map());
}
