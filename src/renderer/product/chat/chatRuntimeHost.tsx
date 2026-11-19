import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';
import type { HermesChatMessage } from '../../../shared/types/hermesChat';
import { ServerPath } from './serverPath';
import { toServerEntries, toThreadMessage } from './chatHistoryMessages';
import { readChatDraft, writeChatDraft } from './chatDrafts';

/**
 * One open chat's runtime and what Hermes holds for it. Every view of the chat renders this
 * same pair, so messages, the running turn's stream and the composer's text are shared.
 */
export interface ChatRuntimeCore {
  runtime: AssistantRuntime;
  serverPath: ServerPath;
}

/**
 * The runtime for one chat, made from the history it opens with. A fresh server path per
 * runtime: it must describe exactly the messages the runtime starts with, or a later send
 * could be mistaken for a rewind.
 */
function useChatRuntimeCore(
  adapter: ChatModelAdapter,
  history: HermesChatMessage[] | undefined
): ChatRuntimeCore {
  const [initialMessages] = useState(() =>
    history && history.length > 0 ? history.map(toThreadMessage) : undefined
  );
  const [serverPath] = useState(() => new ServerPath(toServerEntries(history ?? [])));
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return useMemo(() => ({ runtime, serverPath }), [runtime, serverPath]);
}

/** What a view hands the host when it opens a chat. */
interface LeaseSpec {
  /** Every id the view holds for the chat; `null` for a new chat with no id yet. */
  ids: (string | null)[];
  agentSlug: string | null;
  /** The view's own history load; seeds the runtime only when the view is the first. */
  history: HermesChatMessage[] | undefined;
  /** Runs this view's sends: its session id, tool switch and inference handlers. */
  adapter: ChatModelAdapter;
  sameChat?: (a: string, b: string) => boolean;
}

interface Entry {
  key: string;
  agentSlug: string | null;
  /** Every id any view has held for the chat, kept while no view has it open. */
  ids: Set<string>;
  history: HermesChatMessage[] | undefined;
  /** Leases in the order they were taken; the last one runs sends. */
  leases: Map<string, LeaseSpec>;
  core: ChatRuntimeCore | null;
  running: boolean;
}

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${++nextId}`;

/**
 * The chats open in any view. A chat's runtime lives here, outside the views, from the first
 * view that opens it until the last one closes it and its turn has ended, so closing one
 * view leaves the turn streaming in the other.
 */
class ChatRuntimeHostStore {
  private entries = new Map<string, Entry>();
  private snapshot: Entry[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The entries to mount; a new array whenever one is added or removed. */
  list = (): Entry[] => this.snapshot;

  private emit(listChanged: boolean): void {
    if (listChanged) this.snapshot = [...this.entries.values()];
    for (const listener of [...this.listeners]) listener();
  }

  private matches(entry: Entry, spec: LeaseSpec): boolean {
    if (entry.agentSlug !== spec.agentSlug) return false;
    const same = spec.sameChat ?? ((a: string, b: string) => a === b);
    return spec.ids.filter(isId).some((id) => [...entry.ids].some((other) => same(id, other)));
  }

  /** Opens the chat for a view; returns the lease id and the entry it joined or made. */
  acquire(spec: LeaseSpec): { leaseId: string; key: string } {
    const leaseId = newId('lease');
    // A new chat with no id is never shared: two new chats are two chats.
    let entry = spec.ids.some(isId)
      ? [...this.entries.values()].find((e) => this.matches(e, spec))
      : undefined;
    const added = !entry;
    if (!entry) {
      entry = {
        key: newId('chat'),
        agentSlug: spec.agentSlug,
        ids: new Set(),
        history: spec.history,
        leases: new Map(),
        core: null,
        running: false,
      };
      this.entries.set(entry.key, entry);
    }
    entry.leases.set(leaseId, spec);
    for (const id of spec.ids.filter(isId)) entry.ids.add(id);
    this.emit(added);
    return { leaseId, key: entry.key };
  }

  /** A view's ids or callbacks changed (a new chat got its id). */
  update(key: string, leaseId: string, spec: LeaseSpec): void {
    const entry = this.entries.get(key);
    if (!entry?.leases.has(leaseId)) return;
    entry.leases.set(leaseId, spec);
    for (const id of spec.ids.filter(isId)) entry.ids.add(id);
  }

  release(key: string, leaseId: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.leases.delete(leaseId);
    this.dropIfUnused(entry);
  }

  publish(key: string, core: ChatRuntimeCore): void {
    const entry = this.entries.get(key);
    if (!entry || entry.core === core) return;
    entry.core = core;
    this.emit(false);
  }

  setRunning(key: string, running: boolean): void {
    const entry = this.entries.get(key);
    if (!entry || entry.running === running) return;
    entry.running = running;
    this.dropIfUnused(entry);
  }

  private dropIfUnused(entry: Entry): void {
    if (entry.leases.size > 0 || entry.running) return;
    this.entries.delete(entry.key);
    this.emit(true);
  }

  core(key: string | null): ChatRuntimeCore | null {
    return key ? (this.entries.get(key)?.core ?? null) : null;
  }

  /** The view that runs sends: the one that opened the chat last. */
  lead(key: string): LeaseSpec | null {
    const leases = [...(this.entries.get(key)?.leases.values() ?? [])];
    return leases[leases.length - 1] ?? null;
  }

  /** The ids a draft for this chat is stored under. */
  draftIds(key: string): string[] {
    return [...(this.entries.get(key)?.ids ?? [])];
  }
}

function isId(id: string | null): id is string {
  return typeof id === 'string' && id.length > 0;
}

const HostContext = createContext<ChatRuntimeHostStore | null>(null);

/**
 * Holds the runtimes of the chats open in any view below it. Every HermesChatRuntimeProvider
 * needs one above it; ProductReadyShell mounts it above every screen.
 */
export const ChatRuntimeHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [store] = useState(() => new ChatRuntimeHostStore());
  const entries = useSyncExternalStore(store.subscribe, store.list);
  return (
    <HostContext.Provider value={store}>
      {children}
      {entries.map((entry) => (
        <HostedChatRuntime key={entry.key} entryKey={entry.key} history={entry.history} store={store} />
      ))}
    </HostContext.Provider>
  );
};

const HostedChatRuntime: React.FC<{
  entryKey: string;
  history: HermesChatMessage[] | undefined;
  store: ChatRuntimeHostStore;
}> = ({ entryKey, history, store }) => {
  // Sends go through whichever view opened the chat last, so its session id, tool switch
  // and inference notices apply.
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      run(options) {
        const lead = store.lead(entryKey);
        if (!lead) throw new Error('No view has this chat open');
        return lead.adapter.run(options);
      },
    }),
    [store, entryKey]
  );
  const core = useChatRuntimeCore(adapter, history);

  useEffect(() => {
    const { runtime } = core;
    let unsubs: Array<() => void> = [];
    // The thread exists only once the provider below has mounted it; until then the runtime
    // holds an empty placeholder that refuses every call.
    const attach = () => {
      if (unsubs.length > 0 || runtime.thread.getState().isLoading) return;
      const thread = runtime.thread;
      // The draft belongs to the chat: a view opening it later finds what was typed.
      if (!thread.composer.getState().text) {
        const draft = readChatDraft(store.draftIds(entryKey));
        if (draft) thread.composer.setText(draft);
      }
      const sync = () => {
        store.setRunning(entryKey, thread.getState().isRunning);
        writeChatDraft(store.draftIds(entryKey), thread.composer.getState().text);
      };
      sync();
      unsubs = [thread.subscribe(sync), thread.composer.subscribe(sync)];
      store.publish(entryKey, core);
    };
    const unsubThreads = runtime.threads.subscribe(attach);
    attach();
    return () => {
      unsubThreads();
      for (const unsub of unsubs) unsub();
    };
  }, [core, entryKey, store]);

  // assistant-ui mounts a runtime's thread under the first provider that renders it and
  // remounts it, losing the running turn, when that provider goes. This one stays for as
  // long as the chat is open anywhere, so views can come and go.
  return <AssistantRuntimeProvider runtime={core.runtime}>{null}</AssistantRuntimeProvider>;
};

/**
 * The runtime for the chat a view shows: the host's, shared with every other view of the
 * chat; `null` until the host has made it. Throws without a `ChatRuntimeHost` above.
 */
export function useHostedChatRuntime(spec: LeaseSpec): ChatRuntimeCore | null {
  const store = useContext(HostContext);
  if (!store) throw new Error('HermesChatRuntimeProvider needs a ChatRuntimeHost above it');
  const specRef = useRef(spec);
  specRef.current = spec;
  const [lease, setLease] = useState<{ leaseId: string; key: string } | null>(null);

  useLayoutEffect(() => {
    const taken = store.acquire(specRef.current);
    setLease(taken);
    return () => store.release(taken.key, taken.leaseId);
  }, [store]);

  useLayoutEffect(() => {
    if (lease) store.update(lease.key, lease.leaseId, spec);
  });

  return useSyncExternalStore(store.subscribe, () => store.core(lease?.key ?? null));
}
