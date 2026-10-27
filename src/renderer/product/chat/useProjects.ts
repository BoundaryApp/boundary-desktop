import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentProfile,
  HermesChatThreadSummary,
  HermesProjectMove,
  HermesProjectRecord,
  SessionProjectMark,
} from '../../../shared/types/hermesChat';
import type { CodingFolderInspect } from '../../../shared/types/codingFolders';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { errorText, useSheetAction } from '../../components/ui/use-sheet-action';
import { useOptionalSetup } from '../../setup/SetupContext';
import type { ChatScreenSnapshot } from './chatScreenCache';
import { queueCodingChange } from './codingFoldersStore';
import { conversationTitle as conversationTitleFor } from './conversationKinds';
import type { MoveProjectTarget } from './MoveProjectSheet';
import type { ChatIds } from './useChatIds';
import type { ChatLists } from './useChatLists';
import { keepIfEqual } from './useChatLists';

const PROJECT_TOAST_MS = 8000;

export interface ProjectToast {
  text: string;
  moves?: HermesProjectMove[];
  undo?: () => void;
}

/** What a project-changing call hands back. */
interface ProjectsResult {
  projects?: HermesProjectRecord[];
  activeId?: string | null;
  project?: HermesProjectRecord;
  rpcAvailable?: boolean;
}

/**
 * Projects (ADR 0024): the list and the one the rail shows, creating one (empty or from a
 * folder), moving chats between them with an undo toast, and the moves drawn in the open chat.
 */
export function useProjects({
  cached,
  ids,
  lists,
  activeAgent,
  showCenter,
}: {
  cached: ChatScreenSnapshot | null;
  ids: Pick<ChatIds, 'activeThreadId' | 'sameChat'>;
  lists: Pick<ChatLists, 'threads' | 'setThreads' | 'setChannels' | 'agents'>;
  activeAgent: AgentProfile | null;
  /** Opens the project page after a create. */
  showCenter: (mode: 'project') => void;
}) {
  const { activeThreadId, sameChat } = ids;
  const { threads, setThreads, setChannels, agents } = lists;
  const [projects, setProjects] = useState<HermesProjectRecord[]>(cached?.projects ?? []);
  // ADR 0024: the project the rail shows (navigation). The open conversation's own project
  // comes from the conversation, never from the rail.
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    cached?.activeProjectId ?? null
  );
  const [connecting, setConnecting] = useState(false);
  const [rpcAvailable, setRpcAvailable] = useState(true);
  // A project from the setup flow's Folders step that couldn't be created shows here.
  const firstRunFolderError = useOptionalSetup()?.firstRunFolderError ?? null;
  const [projectError, setProjectError] = useState<string | null>(firstRunFolderError);
  const [projectToast, setProjectToast] = useState<ProjectToast | null>(null);
  const [projectMarks, setProjectMarks] = useState<SessionProjectMark[]>([]);
  // The project main has as active (undefined until the first list). It can lag the rail,
  // which follows the open chat without telling main.
  const mainActiveIdRef = useRef<string | null | undefined>(undefined);

  /** Takes the list, the shown project and the RPC state from a create or folder change. */
  const applyProjectsResult = useCallback((result: ProjectsResult, showCreated = false) => {
    setProjects(result.projects ?? []);
    if (showCreated) {
      const shown = result.activeId ?? result.project?.id ?? null;
      mainActiveIdRef.current = shown;
      setActiveProjectId(shown);
    }
    setRpcAvailable(result.rpcAvailable !== false);
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const result = await window.electronAPI.projects.list();
      if (!result.success) {
        setProjectError(result.error ?? 'Could not load projects.');
        return;
      }
      setProjects(result.projects);
      mainActiveIdRef.current = result.activeId;
      setActiveProjectId(result.activeId);
      setConnecting(Boolean(result.connecting));
      if (typeof result.rpcAvailable === 'boolean') {
        setRpcAvailable(result.rpcAvailable);
      }
    } catch (err) {
      setProjectError(errorText(err));
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  /** Show a project in the rail. Navigation only: no chat's folder changes (ADR 0024 §3). */
  const showProject = useCallback(async (projectId: string | null) => {
    setActiveProjectId(projectId);
    mainActiveIdRef.current = projectId;
    setProjectError(null);
    const result = await window.electronAPI.projects.select({ projectId });
    if (!result.success) {
      setProjectError(result.error ?? 'Could not open that project.');
      return;
    }
    if (result.projects) setProjects(result.projects);
    setRpcAvailable(result.rpcAvailable !== false);
  }, []);

  /**
   * Bring the rail to the open conversation's project. Renderer-only: unlike `showProject`
   * it doesn't select the project in main, so the gateway's active project and the
   * picker's order stay as the last explicit pick left them.
   */
  const followProject = useCallback((projectId: string | null) => {
    setActiveProjectId(projectId);
  }, []);

  // An empty composer's first send starts its chat in main's active project, so main
  // catches up with a followed rail once nothing is open.
  useEffect(() => {
    if (activeThreadId || mainActiveIdRef.current === undefined) return;
    if (activeProjectId !== mainActiveIdRef.current) void showProject(activeProjectId);
  }, [activeThreadId, activeProjectId, showProject]);

  // Moves and folder changes drawn in the transcript.
  const refreshProjectMarks = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setProjectMarks([]);
      return;
    }
    try {
      setProjectMarks(
        keepIfEqual(await window.electronAPI.hermesChat.listProjectMarks({ sessionId }))
      );
    } catch {
      setProjectMarks([]);
    }
  }, []);
  useEffect(() => {
    void refreshProjectMarks(activeThreadId);
  }, [activeThreadId, refreshProjectMarks]);

  useEffect(() => {
    if (!projectToast) return;
    const timer = setTimeout(() => setProjectToast(null), PROJECT_TOAST_MS);
    return () => clearTimeout(timer);
  }, [projectToast]);

  // An empty project (no folder).
  const [emptyProjectOpen, setEmptyProjectOpen] = useState(false);
  const emptyProjectSheet = useSheetAction();
  const handleCreateEmptyProject = useCallback(
    async (name: string) => {
      await emptyProjectSheet.run(async () => {
        const result = await window.electronAPI.projects.createEmpty({ name });
        if (!result.success) {
          emptyProjectSheet.setError(result.error ?? 'Could not create project.');
          return;
        }
        applyProjectsResult(result, true);
        setEmptyProjectOpen(false);
        // A new project opens on its page; no open chat moves into it (ADR 0024).
        showCenter('project');
      });
    },
    [emptyProjectSheet, applyProjectsResult, showCenter]
  );

  // Folder-first create (0005), confirmed in a sheet with the coding switch (ADR 0028 §12).
  const [newProjectFolder, setNewProjectFolder] = useState<CodingFolderInspect | null>(null);
  const newProjectSheet = useSheetAction();
  const handleNewProject = useCallback(async () => {
    setProjectError(null);
    const picked = await window.electronAPI.projects.pickFolder();
    if (picked.canceled || !picked.hostPath) return;
    const folder = await window.electronAPI.codingFolders.inspectFolder({
      hostPath: picked.hostPath,
    });
    if (!folder.success || !folder.hostPath) {
      setProjectError(folder.error ?? 'Could not read that folder.');
      return;
    }
    newProjectSheet.setError(null);
    setNewProjectFolder(folder);
  }, [newProjectSheet]);

  const handleCreateNewProject = useCallback(
    async (input: { name: string; coding: boolean }) => {
      const hostPath = newProjectFolder?.hostPath;
      if (!hostPath) return;
      setConnecting(true);
      try {
        await newProjectSheet.run(async () => {
          const result = await window.electronAPI.projects.createHost({
            hostPath,
            name: input.name,
          });
          if (!result.success) {
            newProjectSheet.setError(result.error ?? 'Could not create project.');
            return;
          }
          applyProjectsResult(result, true);
          showCenter('project');
          setNewProjectFolder(null);
          const projectId = result.project?.id;
          if (input.coding && projectId) {
            // Waits for a running coding task rather than stopping it.
            void queueCodingChange([hostPath], (stopRunningTask) =>
              window.electronAPI.codingFolders.setProjectFolder({
                projectId,
                enabled: true,
                stopRunningTask,
              })
            );
          }
        });
      } finally {
        setConnecting(false);
      }
    },
    [newProjectFolder, newProjectSheet, applyProjectsResult, showCenter]
  );

  /**
   * The composer chip before a chat has messages: re-file it quietly, or with no session yet,
   * choose where it will start (the rail follows).
   */
  const handleDraftProject = useCallback(
    async (projectId: string | null) => {
      if (!activeThreadId) {
        await showProject(projectId);
        return;
      }
      const result = await window.electronAPI.hermesChat.moveToProject({
        sessionIds: [activeThreadId],
        projectId,
        quiet: true,
      });
      if (!result.success) {
        setProjectError(result.error ?? 'Could not change where this chat lives.');
        return;
      }
      setThreads((prev) =>
        prev.map((t) => (sameChat(t.id, activeThreadId) ? { ...t, projectId } : t))
      );
    },
    [activeThreadId, sameChat, showProject, setThreads]
  );

  // Move to project… for the open conversation, or for chats picked in All chats.
  const [moveTarget, setMoveTarget] = useState<MoveProjectTarget | null>(null);
  const moveSheet = useSheetAction();
  const moveAgentName =
    moveTarget?.isDm && activeAgent ? activeAgent.displayName : builtinAgentName(agents);

  const openMove = useCallback(
    (sessionIds: string[]) => {
      if (sessionIds.length === 0) return;
      const picked = sessionIds.map((id) => threads.find((t) => sameChat(t.id, id)));
      const froms = new Set(picked.map((t) => t?.projectId ?? null));
      const label = (thread: HermesChatThreadSummary | undefined) =>
        thread ? `“${conversationTitleFor(thread, agents)}”` : 'this chat';
      moveSheet.setError(null);
      setMoveTarget({
        sessionIds,
        label: sessionIds.length === 1 ? label(picked[0]) : `${sessionIds.length} chats`,
        fromProjectId: froms.size === 1 ? [...froms][0] : undefined,
        isDm: sessionIds.length === 1 && picked[0]?.kind === 'dm',
      });
    },
    [threads, sameChat, agents, moveSheet]
  );

  const applyMoves = useCallback(
    (moves: Array<{ sessionId: string; projectId: string | null }>) => {
      const byId = new Map(moves.map((m) => [m.sessionId, m.projectId]));
      const lookup = (id: string) => {
        for (const [key, projectId] of byId) if (sameChat(key, id)) return { projectId };
        return null;
      };
      setThreads((prev) =>
        prev.map((t) => {
          const hit = lookup(t.id);
          return hit ? { ...t, projectId: hit.projectId } : t;
        })
      );
      setChannels((prev) =>
        prev.map((c) => {
          const hit = lookup(c.sessionId);
          return hit ? { ...c, projectId: hit.projectId } : c;
        })
      );
    },
    [sameChat, setThreads, setChannels]
  );

  const handleMove = useCallback(
    async (projectId: string | null) => {
      if (!moveTarget) return;
      await moveSheet.run(async () => {
        const result = await window.electronAPI.hermesChat.moveToProject({
          sessionIds: moveTarget.sessionIds,
          projectId,
        });
        if (!result.success) {
          moveSheet.setError(result.error ?? 'Could not move.');
          return;
        }
        applyMoves(result.moved.map((m) => ({ sessionId: m.sessionId, projectId })));
        const name = projects.find((p) => p.id === projectId)?.name ?? 'No project';
        setMoveTarget(null);
        if (result.moved.length > 0) {
          setProjectToast({
            text: moveTarget.isDm
              ? `${moveAgentName} now works in ${name}`
              : result.moved.length > 1
                ? `Moved ${result.moved.length} chats to ${name}`
                : `Moved to ${name}`,
            moves: result.moved,
          });
        }
        void refreshProjectMarks(activeThreadId);
      });
    },
    [moveTarget, moveSheet, applyMoves, projects, moveAgentName, refreshProjectMarks, activeThreadId]
  );

  const undoMove = useCallback(async () => {
    const moves = projectToast?.moves;
    if (!moves?.length) return;
    const result = await window.electronAPI.hermesChat.undoProjectMove({ moves });
    if (!result.success) {
      setProjectToast({ text: result.error ?? 'Could not undo the move.' });
      return;
    }
    applyMoves(moves.map((m) => ({ sessionId: m.sessionId, projectId: m.fromProjectId })));
    setProjectToast({ text: 'Move undone' });
    void refreshProjectMarks(activeThreadId);
  }, [projectToast, applyMoves, refreshProjectMarks, activeThreadId]);

  return {
    projects,
    setProjects,
    activeProjectId,
    connecting,
    setConnecting,
    rpcAvailable,
    projectError,
    setProjectError,
    applyProjectsResult,
    refreshProjects,
    showProject,
    followProject,
    projectMarks,
    projectToast,
    setProjectToast,
    undoMove,
    handleDraftProject,
    emptyProject: {
      open: emptyProjectOpen,
      busy: emptyProjectSheet.busy,
      error: emptyProjectSheet.error,
      show: () => {
        emptyProjectSheet.setError(null);
        setEmptyProjectOpen(true);
      },
      create: (name: string): void => void handleCreateEmptyProject(name),
      cancel: () => emptyProjectSheet.dismiss(() => setEmptyProjectOpen(false)),
    },
    newProject: {
      folder: newProjectFolder,
      busy: newProjectSheet.busy,
      error: newProjectSheet.error,
      pick: (): void => void handleNewProject(),
      create: (input: { name: string; coding: boolean }): void => void handleCreateNewProject(input),
      cancel: () => newProjectSheet.dismiss(() => setNewProjectFolder(null)),
    },
    move: {
      target: moveTarget,
      agentName: moveAgentName,
      busy: moveSheet.busy,
      error: moveSheet.error,
      open: openMove,
      move: (projectId: string | null): void => void handleMove(projectId),
      cancel: () => moveSheet.dismiss(() => setMoveTarget(null)),
    },
  };
}

export type Projects = ReturnType<typeof useProjects>;
