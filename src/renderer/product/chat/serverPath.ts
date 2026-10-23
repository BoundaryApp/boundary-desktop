import type { HermesChatRewindRequest } from '../../../shared/types/hermesChat';

/**
 * The chain of runtime messages Hermes holds for this chat, in order.
 *
 * The local runtime keeps every edit and retry as a branch, but Hermes keeps one
 * linear transcript. A run whose message path extends this chain is a normal send;
 * one that stops at a turn already on the chain replaces Hermes's history from that
 * turn (Edit / Retry). A path that leaves the chain earlier is an older version that
 * Hermes no longer has, and cannot be continued (CR 0001 R3).
 */
export interface ServerEntry {
  id: string;
  role: string;
  text: string;
  rowId: number | null;
}

export type RunPlan =
  | { kind: 'append' }
  | { kind: 'rewind'; request: HermesChatRewindRequest }
  /** The path is exactly what Hermes holds and ends on a reply: Continue that reply. */
  | { kind: 'continue' }
  | { kind: 'diverged' };

export class ServerPath {
  private entries: ServerEntry[] = [];
  private ids = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private rewindable = true;

  constructor(entries: ServerEntry[] = []) {
    this.entries = [...entries];
    this.ids = new Set(entries.map((e) => e.id));
  }

  reset(entries: ServerEntry[]): void {
    this.entries = [...entries];
    this.ids = new Set(entries.map((e) => e.id));
    this.notify();
  }

  /** Whether a runtime message is part of what Hermes holds. */
  has(id: string): boolean {
    return this.ids.has(id);
  }

  messageIds(): readonly string[] {
    return this.entries.map((e) => e.id);
  }

  /** False once this chat is known not to support rewinds (HTTP fallback, old gateway). */
  canRewind(): boolean {
    return this.rewindable;
  }

  setRewindable(value: boolean): void {
    if (this.rewindable === value) return;
    this.rewindable = value;
    this.notify();
  }

  plan(path: ServerEntry[]): RunPlan {
    let common = 0;
    while (
      common < path.length &&
      common < this.entries.length &&
      path[common].id === this.entries[common].id
    ) {
      common += 1;
    }
    const last = path.length - 1;
    if (common === this.entries.length && common === last) return { kind: 'append' };
    if (
      common === this.entries.length &&
      common === path.length &&
      path[last]?.role === 'assistant'
    ) {
      return { kind: 'continue' };
    }

    // Edit: everything before the last message matches and the last is new.
    // Retry: the whole path matches and ends on a user turn Hermes already has.
    const target = this.entries[last];
    if (last >= 0 && common >= last && target?.role === 'user') {
      const userOrdinal = this.entries.slice(0, last).filter((e) => e.role === 'user').length;
      return {
        kind: 'rewind',
        request: {
          userOrdinal,
          expectedText: target.text,
          ...(target.rowId != null ? { rowId: target.rowId } : {}),
        },
      };
    }
    return { kind: 'diverged' };
  }

  /** The run's path is now what Hermes holds (it accepted the prompt). */
  commit(path: ServerEntry[]): void {
    this.reset(path);
  }

  /** Add the reply once its run ends, whatever the outcome; the runtime path includes it. */
  append(entry: ServerEntry): void {
    if (this.ids.has(entry.id)) return;
    this.entries.push(entry);
    this.ids.add(entry.id);
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}
