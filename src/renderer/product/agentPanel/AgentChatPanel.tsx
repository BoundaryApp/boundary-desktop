import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentProfile, HermesChatThreadSummary, HermesProjectRecord } from '../../../shared/types/hermesChat';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { HermesChatRuntimeProvider } from '../chat/HermesChatRuntimeProvider';
import { WorkbenchThread } from '../chat/WorkbenchThread';
import { agentChats, landPanelChat, panelChatNow, setPanelChat, usePanelChat } from './agentPanelChat';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';

const noop = (): void => undefined;

interface PanelLists {
  threads: HermesChatThreadSummary[];
  agents: AgentProfile[];
  projects: HermesProjectRecord[];
  connecting: boolean;
  rpcAvailable: boolean;
  /** The first chat list has arrived. */
  loaded: boolean;
}

/** The agent's chats, the agents and the projects, read again whenever main says sessions changed. */
function usePanelLists(): [PanelLists, (thread: HermesChatThreadSummary) => void] {
  const [lists, setLists] = useState<PanelLists>({
    threads: [],
    agents: [],
    projects: [],
    connecting: false,
    rpcAvailable: true,
    loaded: false,
  });
  const load = useCallback(async () => {
    try {
      const [threads, agents, projects] = await Promise.all([
        window.electronAPI.hermesChat.listThreads(),
        window.electronAPI.agents.list(),
        window.electronAPI.projects.list(),
      ]);
      setLists((prev) => ({
        threads: threads.success ? threads.threads : prev.threads,
        agents: agents.success ? agents.agents : prev.agents,
        projects: projects.success ? projects.projects : prev.projects,
        connecting: projects.success ? Boolean(projects.connecting) : prev.connecting,
        rpcAvailable: projects.success ? projects.rpcAvailable !== false : prev.rpcAvailable,
        loaded: prev.loaded || threads.success,
      }));
    } catch {
      // The lists stay as they were; the next sessions change reads them again.
    }
  }, []);
  useEffect(() => {
    void load();
    return window.electronAPI.hermesChat.onSessionsChanged(() => void load());
  }, [load]);
  const addThread = useCallback(
    (thread: HermesChatThreadSummary) =>
      setLists((prev) => ({ ...prev, threads: [thread, ...prev.threads.filter((t) => t.id !== thread.id)] })),
    []
  );
  return [lists, addThread];
}

/**
 * The built-in agent's chat in a 384-pixel panel (ADR 0058 §7, agent window spec decisions 5
 * and 6): a picker of the agent's chats with **New chat**, the privacy line, and the same
 * thread and composer Chat shows, laid out compact. The desktop panel's Agent tab, and 0052's
 * in-window window, draw it.
 */
export const AgentChatPanel: React.FC<{
  /** Opens `chatId` in the app window; a prompt too wide for the panel offers it. */
  onExpand: (chatId: string | null) => void;
}> = ({ onExpand }) => {
  const [lists, addThread] = usePanelLists();
  const chatId = usePanelChat();
  const [toolsEnabled, setToolsEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Hermes can run a chat under another id than the one lists give. The panel keeps the
  // listed id, and hands the runtime the id it runs under so a streaming turn isn't remounted.
  const [runtime, setRuntime] = useState<{ chat: string; id: string } | null>(null);
  const sessionId = runtime && runtime.chat === chatId ? runtime.id : chatId;
  const sameChat = useCallback(
    (a: string, b: string) => a === b || (runtime !== null && [a, b].every((id) => id === runtime.chat || id === runtime.id)),
    [runtime]
  );
  const onSessionResolved = useCallback(
    (resolvedId: string, storedId?: string) => {
      const listed = storedId ?? panelChatNow() ?? resolvedId;
      setRuntime({ chat: listed, id: resolvedId });
      setPanelChat(listed);
    },
    []
  );

  // The first list lands the panel: the chat it last showed, else the agent's newest.
  const { loaded, threads } = lists;
  useEffect(() => {
    if (!loaded) return;
    setPanelChat(landPanelChat(panelChatNow(), threads));
    // Only the first: later lists keep the open chat, even one a send has just renamed.
  }, [loaded]);

  const chats = useMemo(() => agentChats(lists.threads), [lists.threads]);
  const thread = lists.threads.find((t) => t.id === chatId) ?? null;
  const agent = lists.agents.find((a) => a.builtIn) ?? null;
  const name = agent?.displayName ?? builtinAgentName(lists.agents);
  const projectName = (id: string | null | undefined) =>
    lists.projects.find((p) => p.id === id)?.name ?? 'No project';
  const projectId = thread?.projectId ?? null;
  const project = lists.projects.find((p) => p.id === projectId) ?? null;

  const newChat = async () => {
    setError(null);
    try {
      const result = await window.electronAPI.hermesChat.createHermesChat({ projectId });
      if (!result.success || !result.thread) {
        setError(result.error ?? 'Could not start a chat.');
        return;
      }
      addThread(result.thread);
      setPanelChat(result.thread.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const compact = useMemo(
    () => ({ placeholder: `Ask ${name} · only you see this`, onOpenInWindow: () => onExpand(chatId) }),
    [name, onExpand, chatId]
  );

  return (
    <div className="wb-agent-panel">
      <div className="wb-agent-panel-bar">
        <NativeSelect
          size="sm"
          className="wb-agent-panel-picker"
          aria-label="Chat"
          value={chatId ?? ''}
          onChange={(event) => setPanelChat(event.target.value || null)}
        >
          {chatId && !chats.some((c) => c.id === chatId) ? <option value={chatId}>{thread?.title || 'New chat'}</option> : null}
          {chats.length === 0 && !chatId ? <option value="">New chat</option> : null}
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.title || 'New chat'} · ${projectName(c.projectId)}`}
            </option>
          ))}
        </NativeSelect>
        <Button variant="secondary" size="sm" type="button" onClick={() => void newChat()}>
          New chat
        </Button>
      </div>
      <p className="wb-agent-panel-privacy">Only you and {name} see this. It stays on this Mac.</p>
      {error ? (
        <p className="wb-agent-panel-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-agent-panel-thread">
        <HermesChatRuntimeProvider
          sessionId={sessionId}
          toolsEnabled={toolsEnabled}
          onSessionResolved={onSessionResolved}
          sameChat={sameChat}
        >
          <WorkbenchThread
            sessionId={sessionId}
            sameChat={sameChat}
            threadTitle={thread?.title || 'New chat'}
            agent={agent}
            kind="hermes"
            agents={lists.agents}
            activeProject={project}
            projects={lists.projects}
            activeProjectId={projectId}
            connecting={lists.connecting}
            rpcAvailable={lists.rpcAvailable}
            toolsEnabled={toolsEnabled}
            onToolsEnabledChange={setToolsEnabled}
            onSelectProject={noop}
            onClearProject={noop}
            onNewProject={noop}
            startedAt={thread?.createdAt ?? null}
            compact={compact}
          />
        </HermesChatRuntimeProvider>
      </div>
    </div>
  );
};
