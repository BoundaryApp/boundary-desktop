/**
 * Decides which Circle chat messages become macOS notifications. It holds no Electron or store
 * references: the caller supplies the Circle's facts, this device's preferences, and `show`.
 *
 * Messages are queued per Circle and flushed 1,500 ms after the first one (main's clock, not the
 * message's `at`). At flush, messages read or being viewed are dropped, the Circle's level picks
 * which remain, and up to three become notices. More than three become one summary.
 */
import { mentionsMe, resolveNotifyLevel } from '../../../shared/circleMentions';
import { repliesToMe } from '../../../shared/circleReplies';
import type {
  CircleMessage,
  CircleMessageRef,
  CircleNotifyGlobal,
  CircleNotifyPrefs,
  DirectMessage,
} from '../../../shared/types/circles';

const BATCH_MS = 1500;
const MAX_INDIVIDUAL = 3;
const MAX_BODY = 150;

export interface CircleNotice {
  title: string;
  body: string;
  open: { circleKey: string; channel: string; ref: CircleMessageRef };
}

export interface CircleNotifierDeps {
  identity: () => string;
  /** Null when this device no longer has the Circle. */
  describe: (
    circleKey: string,
  ) => Promise<{ name: string; people: number; channelNames: Record<string, string> } | null>;
  prefs: (circleKey: string) => CircleNotifyPrefs;
  global: () => CircleNotifyGlobal;
  show: (notice: CircleNotice) => void;
  /** Counts, short keys, levels and reasons only. Never names or message text. */
  log: (data: Record<string, unknown>) => void;
}

/** An edit, delete or confirmation, or a message that disappeared when its order settled. */
export type CircleMessageChange =
  | { kind: 'changed'; message: CircleMessage }
  | ({ kind: 'gone'; circleKey: string; channel: string } & CircleMessageRef);

export interface Viewing {
  circleKey: string;
  channel: string;
  focused: boolean;
}

interface Queued {
  message: CircleMessage;
  /** `noteRead` ran for its channel after it was queued. */
  read: boolean;
  /** A direct message (ADR 0054 §10); its `channel` is `dm:` and the sender's identity. */
  direct?: true;
}

/** Where a direct conversation is viewed and opened: the slot a channel id would take. */
const directChannel = (peer: string): string => `dm:${peer}`;

/** A direct message in the shape the queue holds, under the sender's name. */
function fromDirect(circleKey: string, peer: string, name: string, message: DirectMessage): CircleMessage {
  return {
    circleKey,
    channel: directChannel(peer),
    author: message.author,
    id: message.id,
    name,
    agent: null,
    text: message.text,
    at: message.at,
    confirmed: true,
    edited: message.edited,
    deleted: message.deleted ? 'author' : null,
    shared: null,
    call: null,
    mentions: null,
    reply: null,
    reactions: [],
    mine: message.mine,
  };
}

/** Message text with Markdown removed, at most 150 characters (`…` when cut). */
export function plainPreview(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1)}…` : plain;
}

export function createCircleNotifier(
  deps: CircleNotifierDeps,
  /** What the renderer showed before this notifier existed, such as before a network restart. */
  initialViewing: Viewing | null = null,
): {
  onMessage(message: CircleMessage): void;
  onChange(change: CircleMessageChange): void;
  /** A direct message from `peer`, the first time this device sees it. */
  onDirect(circleKey: string, peer: string, name: string, message: DirectMessage): void;
  /** An edit or delete of a direct message from `peer`. */
  onDirectChange(circleKey: string, peer: string, name: string, message: DirectMessage): void;
  noteRead(circleKey: string, channel: string): void;
  setViewing(viewing: Viewing | null): void;
  dispose(): void;
} {
  const queues = new Map<string, Queued[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let viewing: Viewing | null = initialViewing;
  let disposed = false;

  const isViewed = (circleKey: string, channel: string): boolean =>
    viewing !== null && viewing.focused && viewing.circleKey === circleKey && viewing.channel === channel;

  async function flush(circleKey: string): Promise<void> {
    timers.delete(circleKey);
    const batch = queues.get(circleKey) ?? [];
    queues.delete(circleKey);
    if (disposed || batch.length === 0) return;

    const log: Record<string, unknown> = { circle: circleKey.slice(0, 8), queued: batch.length, shown: 0, summary: false };

    let circle: Awaited<ReturnType<CircleNotifierDeps['describe']>>;
    try {
      circle = await deps.describe(circleKey);
    } catch {
      if (!disposed) deps.log({ ...log, reason: 'describe failed' });
      return;
    }
    if (disposed) return;
    if (!circle) {
      deps.log({ ...log, reason: 'no circle' });
      return;
    }

    const dropped = { read: 0, viewing: 0, level: 0 };
    const live: CircleMessage[] = [];
    const fromDm = new Set<CircleMessage>();
    for (const q of batch) {
      if (q.read) dropped.read += 1;
      else if (isViewed(q.message.circleKey, q.message.channel)) dropped.viewing += 1;
      else {
        live.push(q.message);
        if (q.direct) fromDm.add(q.message);
      }
    }

    const prefs = deps.prefs(circleKey);
    const level = resolveNotifyLevel(prefs.level, circle.people);
    const global = deps.global();
    const me = deps.identity();
    const isMention = (m: CircleMessage): boolean => mentionsMe(m.mentions, me, prefs.channelMentions) || repliesToMe(m, me);
    const kept = global.enabled
      ? level === 'all'
        ? live
        : level === 'mentions'
          ? live.filter((m) => fromDm.has(m) || isMention(m))
          : []
      : [];
    dropped.level = live.length - kept.length;

    const channelLabel = (m: CircleMessage): string => circle.channelNames[m.channel] ?? m.channel;
    const refOf = (m: CircleMessage) => ({
      circleKey: m.circleKey,
      channel: m.channel,
      ref: { author: m.author, id: m.id },
    });

    const notices: CircleNotice[] = [];
    if (kept.length > MAX_INDIVIDUAL) {
      const newest = kept[kept.length - 1];
      const newestMention = [...kept].reverse().find((m) => isMention(m) || fromDm.has(m));
      const target = newestMention ?? newest;
      const tail = !newestMention
        ? ''
        : fromDm.has(newestMention)
          ? ` · ${newestMention.name} sent you a direct message`
          : ` · ${newestMention.name} mentioned you`;
      notices.push({ title: circle.name, body: `${kept.length} new messages${tail}`, open: refOf(target) });
      log.summary = true;
    } else {
      for (const m of kept) {
        if (fromDm.has(m)) {
          notices.push({
            title: `${m.name} · Direct message in ${circle.name}`,
            body: global.showText ? plainPreview(m.text) || 'New message' : 'New message',
            open: refOf(m),
          });
          continue;
        }
        const ch = channelLabel(m);
        const mentions = m.mentions;
        const direct = mentions?.members.includes(me) === true;
        const mention = isMention(m);
        const reply = repliesToMe(m, me);
        let title: string;
        if (reply) title = `${m.agent ? `${m.name}’s ${m.agent.name}` : m.name} replied to you in #${ch} · ${circle.name}`;
        else if (mention && direct) title = `${m.name} mentioned you in #${ch} · ${circle.name}`;
        else if (mention) title = `${m.name} mentioned #${ch} · ${circle.name}`;
        else if (m.agent) title = `${m.name}’s ${m.agent.name} in #${ch} · ${circle.name}`;
        else title = `${m.name} in #${ch} · ${circle.name}`;

        let body: string;
        if (m.call && m.call.ended === undefined) body = `${m.name} started a call in #${ch}`;
        else {
          const fallback = reply ? 'Replied to you' : mention ? 'Mentioned you' : 'New message';
          body = global.showText ? plainPreview(m.text) || fallback : fallback;
        }
        notices.push({ title, body, open: refOf(m) });
      }
    }

    deps.log({ ...log, shown: notices.length, level, dropped });
    for (const n of notices) deps.show(n);
  }

  function onChange(change: CircleMessageChange): void {
    const key = change.kind === 'changed' ? change.message.circleKey : change.circleKey;
    const ref = change.kind === 'changed' ? change.message : change;
    const queue = queues.get(key);
    const index = queue?.findIndex(
      (q) => q.message.channel === ref.channel && q.message.author === ref.author && q.message.id === ref.id,
    );
    if (!queue || index === undefined || index === -1) return;
    // A deleted or vanished message is dropped; an edit replaces the text the notice will show.
    if (change.kind === 'gone' || change.message.deleted) queue.splice(index, 1);
    else queue[index] = { ...queue[index], message: change.message };
  }

  return {
    onMessage(message) {
      if (disposed || message.mine || message.deleted) return;
      if (isViewed(message.circleKey, message.channel)) return;
      const queue = queues.get(message.circleKey) ?? [];
      queue.push({ message, read: false });
      queues.set(message.circleKey, queue);
      if (!timers.has(message.circleKey)) {
        timers.set(
          message.circleKey,
          setTimeout(() => void flush(message.circleKey), BATCH_MS),
        );
      }
    },
    onDirect(circleKey, peer, name, message) {
      if (disposed || message.mine || message.deleted) return;
      const converted = fromDirect(circleKey, peer, name, message);
      if (isViewed(circleKey, converted.channel)) return;
      const queue = queues.get(circleKey) ?? [];
      queue.push({ message: converted, read: false, direct: true });
      queues.set(circleKey, queue);
      if (!timers.has(circleKey)) timers.set(circleKey, setTimeout(() => void flush(circleKey), BATCH_MS));
    },
    onDirectChange(circleKey, peer, name, message) {
      onChange({ kind: 'changed', message: fromDirect(circleKey, peer, name, message) });
    },
    onChange,
    noteRead(circleKey, channel) {
      for (const q of queues.get(circleKey) ?? []) {
        if (q.message.channel === channel) q.read = true;
      }
    },
    setViewing(next) {
      viewing = next;
    },
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      queues.clear();
    },
  };
}
