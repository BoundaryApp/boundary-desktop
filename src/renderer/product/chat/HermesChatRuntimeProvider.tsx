import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { createHermesChatModelAdapter } from './hermesChatModelAdapter';
import type {
  HermesChatMessage,
  SessionInferenceOverride,
} from '../../../shared/types/hermesChat';
import { ServerPath, type ServerEntry } from './serverPath';
import type { HermesMessageCustom } from './messageCustom';
import { findRunningTurn, isOwnedRunningTurn, useRunningTurns } from './runningTurns';

/**
 * Hydrated history row → runtime message. `custom.ts` is always set (null when the
 * source had no time) so the transcript never mistakes load time for send time;
 * live turns have no `custom.ts` and use the runtime's own `createdAt`.
 * The id is fixed so the server path can name hydrated messages before the runtime exists.
 */
const historyMessageId = (index: number) => `hist-${index}`;

function toServerEntries(messages: HermesChatMessage[]): ServerEntry[] {
  return messages.map((m, i) => ({
    id: historyMessageId(i),
    role: m.role,
    text: m.content,
    rowId: m.rowId ?? null,
    ...(m.localOnly ? { localOnly: true } : {}),
  }));
}

const ServerPathContext = createContext<ServerPath | null>(null);

/**
 * True from the moment a turn this screen did not stream ends until its reply has been
 * loaded, so the transcript does not call the turn unanswered in between.
 */
const HistoryRefreshingContext = createContext(false);

export function useHistoryRefreshing(): boolean {
  return useContext(HistoryRefreshingContext);
}

/** What Hermes holds for the open chat; null outside a Hermes chat runtime. */
export function useServerPath(): ServerPath | null {
  return useContext(ServerPathContext);
}

export function toThreadMessage(m: HermesChatMessage, index: number): ThreadMessageLike {
  return {
    id: historyMessageId(index),
    role: m.role,
    content: m.content,
    ...(m.timestamp != null ? { createdAt: new Date(m.timestamp * 1000) } : {}),
    metadata: {
      custom: {
        ts: m.timestamp ?? null,
        rowId: m.rowId ?? null,
        ...(m.files && m.files.length > 0 ? { files: m.files } : {}),
        ...(m.tasksFiled && m.tasksFiled.length > 0 ? { tasksFiled: m.tasksFiled } : {}),
        ...(m.toolCount != null ? { toolCount: m.toolCount } : {}),
        ...(m.ending ? { ending: m.ending } : {}),
        ...(m.noReply ? { noReply: m.noReply } : {}),
        ...(m.localOnly ? { localOnly: true } : {}),
        // Who spoke this turn in a room; the reply's speaker line reads it (ADR 0023).
        ...(m.agentSlug ? { agentSlug: m.agentSlug } : {}),
      } satisfies HermesMessageCustom,
    },
  };
}

interface InferenceSendHandlers {
  onLocalUnreachable: () => void;
  onPrivateRefused: () => void;
  /** The inference a chat with no session yet sends its first turn with, taken once. */
  takeNewChatInference?: () => SessionInferenceOverride | null;
}

const InferenceSendContext = createContext<{
  register: (handlers: InferenceSendHandlers) => () => void;
} | null>(null);

export function useInferenceSendHandlers(handlers: InferenceSendHandlers): void {
  const ctx = useContext(InferenceSendContext);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    if (!ctx) return undefined;
    return ctx.register({
      onLocalUnreachable: () => handlersRef.current.onLocalUnreachable(),
      onPrivateRefused: () => handlersRef.current.onPrivateRefused(),
      takeNewChatInference: () => handlersRef.current.takeNewChatInference?.() ?? null,
    });
  }, [ctx]);
}

interface HermesChatRuntimeProviderProps {
  sessionId: string | null;
  agentSlug?: string | null;
  toolsEnabled?: boolean;
  onSessionResolved?: (sessionId: string) => void;
  /** Whether two ids name the same chat (a runtime id and its stored id). */
  sameChat?: (a: string, b: string) => boolean;
  children: React.ReactNode;
}

export const HermesChatRuntimeProvider: React.FC<HermesChatRuntimeProviderProps> = ({
  sessionId,
  agentSlug = null,
  toolsEnabled = true,
  onSessionResolved,
  sameChat,
  children,
}) => {
  const [history, setHistory] = useState<HermesChatMessage[] | undefined>(undefined);
  // A reload of the open chat, applied to the mounted runtime in place (keeps the composer).
  const [refreshed, setRefreshed] = useState<HermesChatMessage[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const loadedForRef = useRef<string | null>(null);
  // Owned by the mounted runtime (HermesChatRuntimeInner); the adapter reads it per run.
  const serverPathRef = useRef<ServerPath | null>(null);
  const [historyReady, setHistoryReady] = useState(!sessionId);
  // Which chat `history` belongs to. On a switch, the first render still holds the old
  // chat's history; mounting then would seed the new runtime (and its server path)
  // with the wrong messages and spend one-shot props such as a branch draft.
  const [historyFor, setHistoryFor] = useState<string | null>(sessionId);
  // The id the mounted runtime was made for. A send can hand back this chat's real session
  // id (a DM's placeholder gets one on its first send); that id is adopted in place, so the
  // runtime keeps the turn it is streaming instead of remounting and dropping it.
  const [mountKey, setMountKey] = useState<string>(sessionId ?? 'none');
  const adoptedRef = useRef<{ from: string; to: string } | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const adopting =
    adoptedRef.current !== null &&
    adoptedRef.current.to === sessionId &&
    historyFor === adoptedRef.current.from;
  const toolsEnabledRef = useRef(toolsEnabled);
  toolsEnabledRef.current = toolsEnabled;
  const agentSlugRef = useRef(agentSlug);
  agentSlugRef.current = agentSlug;
  const onSessionResolvedRef = useRef(onSessionResolved);
  onSessionResolvedRef.current = onSessionResolved;
  const sendHandlersRef = useRef<InferenceSendHandlers | null>(null);

  const register = useCallback((handlers: InferenceSendHandlers) => {
    sendHandlersRef.current = handlers;
    return () => {
      if (sendHandlersRef.current === handlers) {
        sendHandlersRef.current = null;
      }
    };
  }, []);

  // A turn left running when this chat was closed: once it ends, load its reply. Turns
  // this screen streams itself already show their reply and are skipped.
  const runningTurn = findRunningTurn(useRunningTurns(), sessionId, sameChat);
  const watchedRef = useRef<{ chat: string | null; requestId: string | null }>({
    chat: null,
    requestId: null,
  });
  useEffect(() => {
    const prev = watchedRef.current;
    const requestId = runningTurn?.requestId ?? null;
    watchedRef.current = { chat: sessionId ?? null, requestId };
    if (prev.chat !== (sessionId ?? null) || !prev.requestId || prev.requestId === requestId) {
      return;
    }
    if (!isOwnedRunningTurn(prev.requestId)) {
      setRefreshing(true);
      setReloadKey((k) => k + 1);
    }
  }, [sessionId, runningTurn?.requestId]);

  useEffect(() => {
    let cancelled = false;
    const adopted = adoptedRef.current;
    if (adopted && adopted.to === sessionId && loadedForRef.current === adopted.from) {
      adoptedRef.current = null;
      loadedForRef.current = sessionId;
      setHistoryFor(sessionId);
      return;
    }
    adoptedRef.current = null;
    if (!sessionId) {
      setHistory(undefined);
      setHistoryFor(null);
      setMountKey('none');
      setHistoryReady(true);
      loadedForRef.current = null;
      return;
    }

    // Reloading the open chat keeps it on screen until the new history arrives.
    const reloading = loadedForRef.current === sessionId;
    if (!reloading) {
        setHistoryReady(false);
      setHistory(undefined);
      setRefreshed(null);
    }

    void (async () => {
      try {
        const result = await window.electronAPI.hermesChat.getHistory({ sessionId });
        if (cancelled) return;
        if (
          result.sessionId &&
          result.sessionId !== sessionId &&
          onSessionResolvedRef.current
        ) {
          onSessionResolvedRef.current(result.sessionId);
        }
        // A branch's copied messages lost their times and tool rows when Hermes seeded
        // them; show neither rather than the moment of branching or "No tools used".
        const seeded = result.branch?.seededCount ?? 0;
        const loaded = result.success
          ? result.messages.map((m, i) =>
              i < seeded ? { ...m, timestamp: undefined, toolCount: undefined } : m
            )
          : [];
        if (!reloading) setHistory(loaded);
        else if (result.success) setRefreshed(loaded);
      } catch {
        if (!cancelled && !reloading) setHistory([]);
      } finally {
        if (!cancelled) {
          setHistoryFor(sessionId);
          setMountKey(sessionId);
          setHistoryReady(true);
          setRefreshing(false);
          loadedForRef.current = sessionId;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadKey]);

  const adapter = useMemo<ChatModelAdapter>(
    () =>
      createHermesChatModelAdapter(() => sessionId, {
        getToolsEnabled: () => toolsEnabledRef.current,
        getAgentSlug: () => agentSlugRef.current,
        onSessionResolved: (id) => {
          const from = sessionIdRef.current;
          if (from && from !== id) adoptedRef.current = { from, to: id };
          onSessionResolvedRef.current?.(id);
        },
        onLocalUnreachable: () => sendHandlersRef.current?.onLocalUnreachable(),
        onPrivateRefused: () => sendHandlersRef.current?.onPrivateRefused(),
        takeNewChatInference: () => sendHandlersRef.current?.takeNewChatInference?.() ?? null,
        getServerPath: () => serverPathRef.current,
      }),
    [sessionId]
  );

  const sendContext = useMemo(() => ({ register }), [register]);

  // Remount LocalRuntime when session or hydrated history changes.
  if (!adopting && (!historyReady || historyFor !== (sessionId ?? null))) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-ui text-fg-faint">
        Loading chat…
      </div>
    );
  }

  return (
    <InferenceSendContext.Provider value={sendContext}>
      <HistoryRefreshingContext.Provider value={refreshing}>
        <HermesChatRuntimeInner
          key={`${mountKey}:${agentSlug ?? ''}`}
          adapter={adapter}
          history={history}
          refreshed={refreshed}
          serverPathRef={serverPathRef}
        >
          {children}
        </HermesChatRuntimeInner>
      </HistoryRefreshingContext.Provider>
    </InferenceSendContext.Provider>
  );
};

const HermesChatRuntimeInner: React.FC<{
  adapter: ChatModelAdapter;
  history?: HermesChatMessage[];
  /** A newer copy of this chat's history (a background turn ended); applied in place. */
  refreshed: HermesChatMessage[] | null;
  serverPathRef: React.MutableRefObject<ServerPath | null>;
  children: React.ReactNode;
}> = ({ adapter, history, refreshed, serverPathRef, children }) => {
  const [initialMessages] = useState(() =>
    history && history.length > 0 ? history.map(toThreadMessage) : undefined
  );
  // A fresh server path per mount: it must describe exactly the messages this runtime
  // starts with, or a later send could be mistaken for a rewind.
  const [serverPath] = useState(() => new ServerPath(toServerEntries(history ?? [])));
  serverPathRef.current = serverPath;

  const runtime = useLocalRuntime(adapter, { initialMessages });

  useEffect(() => {
    if (!refreshed || runtime.thread.getState().isRunning) return;
    runtime.thread.reset(refreshed.map(toThreadMessage));
    serverPath.reset(toServerEntries(refreshed));
  }, [refreshed, runtime, serverPath]);

  return (
    <ServerPathContext.Provider value={serverPath}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </ServerPathContext.Provider>
  );
};
