import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AssistantRuntimeProvider, type ChatModelAdapter } from '@assistant-ui/react';
import { createHermesChatModelAdapter, type InferenceSendHandlers } from './hermesChatModelAdapter';
import type { HermesChatMessage } from '../../../shared/types/hermesChat';
import type { ServerPath } from './serverPath';
import { toServerEntries, toThreadMessage } from './chatHistoryMessages';
import { findRunningTurn, isOwnedRunningTurn, useRunningTurns } from './runningTurns';
import { useHostedChatRuntime, type ChatRuntimeCore } from './chatRuntimeHost';
import { ChatAdoptionContext, type IsAdoption } from './useOnChatSwitch';

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

/** Reads the screen's current send handlers; registered once per mounted thread. */
type GetSendHandlers = () => InferenceSendHandlers;

const InferenceSendContext = createContext<{
  register: (get: GetSendHandlers) => () => void;
} | null>(null);

export function useInferenceSendHandlers(handlers: InferenceSendHandlers): void {
  const ctx = useContext(InferenceSendContext);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => ctx?.register(() => handlersRef.current), [ctx]);
}

interface HermesChatRuntimeProviderProps {
  sessionId: string | null;
  agentSlug?: string | null;
  toolsEnabled?: boolean;
  onSessionResolved?: (sessionId: string, storedId?: string) => void;
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
  // id (a DM's placeholder or a new chat with no id gets one on its first send); that id is
  // adopted in place, so the runtime keeps the turn it is streaming instead of remounting
  // and dropping it. `from` is null for a new chat.
  const [mountKey, setMountKey] = useState<string>(sessionId ?? 'none');
  const adoptedRef = useRef<{ from: string | null; to: string } | null>(null);
  // The last adoption, kept after the effect below has handled it: the thread's per-chat
  // state reads it to tell adoption from a switch (useOnChatSwitch).
  const lastAdoptionRef = useRef<{ from: string | null; to: string } | null>(null);
  const isAdoption = useCallback<IsAdoption>((from, to) => {
    const last = lastAdoptionRef.current;
    return last !== null && last.from === from && last.to === to;
  }, []);
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
  const sendHandlersRef = useRef<GetSendHandlers | null>(null);

  const register = useCallback((get: GetSendHandlers) => {
    sendHandlersRef.current = get;
    return () => {
      if (sendHandlersRef.current === get) {
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
        onSessionResolved: (id, storedId) => {
          const from = sessionIdRef.current;
          if (from !== id) {
            adoptedRef.current = { from, to: id };
            lastAdoptionRef.current = { from, to: id };
          }
          onSessionResolvedRef.current?.(id, storedId);
        },
        getSendHandlers: () => sendHandlersRef.current?.() ?? null,
        getServerPath: () => serverPathRef.current,
      }),
    [sessionId]
  );

  const sendContext = useMemo(() => ({ register }), [register]);

  // Remount LocalRuntime when session or hydrated history changes.
  if (!adopting && (!historyReady || historyFor !== (sessionId ?? null))) {
    return <LoadingChat />;
  }

  return (
    <InferenceSendContext.Provider value={sendContext}>
      <ChatAdoptionContext.Provider value={isAdoption}>
        <HistoryRefreshingContext.Provider value={refreshing}>
          <HermesChatRuntimeInner
            key={`${mountKey}:${agentSlug ?? ''}`}
            adapter={adapter}
            history={history}
            refreshed={refreshed}
            serverPathRef={serverPathRef}
            ids={[mountKey === 'none' ? null : mountKey, sessionId]}
            agentSlug={agentSlug}
            sameChat={sameChat}
          >
            {children}
          </HermesChatRuntimeInner>
        </HistoryRefreshingContext.Provider>
      </ChatAdoptionContext.Provider>
    </InferenceSendContext.Provider>
  );
};

/** The runtime for the open chat: the host's, shared with any other view of the same chat. */
const HermesChatRuntimeInner: React.FC<{
  adapter: ChatModelAdapter;
  history?: HermesChatMessage[];
  /** A newer copy of this chat's history (a background turn ended); applied in place. */
  refreshed: HermesChatMessage[] | null;
  serverPathRef: React.MutableRefObject<ServerPath | null>;
  ids: (string | null)[];
  agentSlug: string | null;
  sameChat?: (a: string, b: string) => boolean;
  children: React.ReactNode;
}> = ({ adapter, history, refreshed, serverPathRef, ids, agentSlug, sameChat, children }) => {
  const core = useHostedChatRuntime({ ids, agentSlug, history, adapter, sameChat });
  // The host mounts the thread over a commit or two.
  if (!core) return <LoadingChat />;
  return (
    <ChatRuntimeView core={core} refreshed={refreshed} serverPathRef={serverPathRef}>
      {children}
    </ChatRuntimeView>
  );
};

const LoadingChat: React.FC = () => (
  <div className="flex h-full min-h-0 items-center justify-center text-ui text-fg-faint">
    Loading chat…
  </div>
);

const ChatRuntimeView: React.FC<{
  core: ChatRuntimeCore;
  refreshed: HermesChatMessage[] | null;
  serverPathRef: React.MutableRefObject<ServerPath | null>;
  children: React.ReactNode;
}> = ({ core, refreshed, serverPathRef, children }) => {
  const { runtime, serverPath } = core;
  // This view's sends read the chat's server path through its adapter.
  serverPathRef.current = serverPath;

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
