import type {
  ChannelRecord,
  HermesChatThreadSummary,
  HermesMoveToProjectPayload,
  HermesMoveToProjectResult,
  HermesProjectMove,
  HermesProjectRecord,
  HermesUndoProjectMovePayload,
  SessionProjectMark,
} from '../../../../shared/types/hermesChat';
import {
  appendSessionProjectMark,
  getSessionProjectId,
  getStandingDmMap,
  getWebuiRefiledAt,
  listSessionProjectMarks,
  removeSessionProjectMark,
  setSessionProjectIds,
  setWebuiRefiledAt,
  upsertStoredChannel,
} from './hermesAgentStore';
import { channelForSession } from './hermesChannels';
import { durableSessionId } from './hermesAgents';
import { getHermesGatewaySession } from './hermesGatewaySession';
import { getStoredHermesProject, listStoredHermesProjects } from './hermesProjectStore';
import { listRunningTurns } from './hermesRunningTurns';

// ADR 0024: every conversation stores its project, and that project is the only one that
// applies to it. The rail's project (the store's activeId) is navigation and never reaches
// a chat. A DM stores the folder it works in the same way, but is never filed under it.

/** The ids a session may be known by: as given, and its stored id. */
function idsFor(sessionId: string): string[] {
  return [...new Set([sessionId, durableSessionId(sessionId)])];
}

function storedProjectId(sessionId: string): string | null | undefined {
  const room = channelForSession(sessionId);
  if (room) return 'projectId' in room ? (room.projectId ?? null) : undefined;
  for (const id of idsFor(sessionId)) {
    const stored = getSessionProjectId(id);
    if (stored !== undefined) return stored;
  }
  return undefined;
}

/** The conversation's project, or null. A removed project reads as No project. */
export function conversationProjectId(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const id = storedProjectId(sessionId);
  return id && getStoredHermesProject(id) ? id : null;
}

/** File a new conversation: the room record for a channel, session meta otherwise. */
export function setConversationProjectId(
  sessionIds: Array<string | null | undefined>,
  projectId: string | null
): void {
  // A runtime id's stored id gets the same folder, so the chat keeps it once it is listed.
  const ids = [
    ...new Set(sessionIds.filter((id): id is string => Boolean(id)).flatMap(idsFor)),
  ];
  if (ids.length === 0) return;
  const room = ids.map((id) => channelForSession(id)).find(Boolean);
  if (room) {
    upsertStoredChannel({ ...room, projectId });
    return;
  }
  setSessionProjectIds(Object.fromEntries(ids.map((id) => [id, projectId])));
}

/** The project whose container folder holds `cwd`, if any. */
export function projectForCwd(
  cwd: string | undefined,
  projects: readonly HermesProjectRecord[]
): HermesProjectRecord | null {
  if (!cwd) return null;
  const clean = cwd.replace(/\/+$/, '');
  // Longest path wins when one project's folder sits inside another's.
  return (
    [...projects]
      .filter((p) => p.containerPath)
      .sort((a, b) => b.containerPath.length - a.containerPath.length)
      .find((p) => {
        const root = p.containerPath.replace(/\/+$/, '');
        return clean === root || clean.startsWith(`${root}/`);
      }) ?? null
  );
}

/**
 * Put each thread's project on it. A conversation never filed before (it predates 0024, or
 * came from Telegram or WebUI) is filed once, under the project whose folder holds the cwd
 * Hermes last reported (for WebUI, the workspace picked there), else under No project. The
 * result is saved, so it never drifts.
 *
 * Before Boundary read WebUI's workspace, every WebUI chat was filed under No project. The
 * first list that includes WebUI chats files those again from their workspace, once. A chat
 * someone moved by hand has a move mark and keeps its place. This is a one-time migration
 * kept here rather than in src/main/migrations: it needs the chat list's WebUI workspaces, and
 * each stack records its own `webuiRefiledAt`. Remove after release 0.1.0.
 */
export function fileThreads(threads: HermesChatThreadSummary[]): HermesChatThreadSummary[] {
  const projects = listStoredHermesProjects();
  const known = new Set(projects.map((p) => p.id));
  const sessionFilings: Record<string, string | null> = {};
  const roomFilings = new Map<string, ChannelRecord>();
  const refileWebui = !getWebuiRefiledAt();
  let sawWebui = false;

  const filed = threads.map((thread) => {
    const { cwd, ...rest } = thread;
    const room = channelForSession(thread.id);
    const fromWebui = thread.source === 'webui' && Boolean(cwd) && !room;
    if (fromWebui) sawWebui = true;
    let projectId = storedProjectId(thread.id);
    if (projectId === undefined) {
      projectId = projectForCwd(cwd, projects)?.id ?? null;
      if (room) roomFilings.set(room.id, { ...room, projectId });
      else sessionFilings[thread.id] = projectId;
    } else if (
      refileWebui &&
      fromWebui &&
      projectId === null &&
      listConversationProjectMarks(thread.id).length === 0
    ) {
      const found = projectForCwd(cwd, projects)?.id ?? null;
      if (found) {
        projectId = found;
        sessionFilings[thread.id] = found;
      }
    }
    return { ...rest, projectId: projectId && known.has(projectId) ? projectId : null };
  });

  setSessionProjectIds(sessionFilings);
  for (const room of roomFilings.values()) upsertStoredChannel(room);
  if (refileWebui && sawWebui) setWebuiRefiledAt(new Date().toISOString());
  return filed;
}

/** Rooms with no project yet are filed under No project; a room has no cwd of its own here. */
export function fileChannels(channels: ChannelRecord[]): ChannelRecord[] {
  const known = new Set(listStoredHermesProjects().map((p) => p.id));
  return channels.map((room) => ({
    ...room,
    projectId: room.projectId && known.has(room.projectId) ? room.projectId : null,
  }));
}

function isStandingDm(sessionId: string): boolean {
  const ids = new Set(idsFor(sessionId));
  return Object.values(getStandingDmMap()).some((id) => Boolean(id && ids.has(id)));
}

function isRunning(sessionId: string): boolean {
  const ids = new Set(idsFor(sessionId));
  return listRunningTurns().some((turn) => turn.sessionIds.some((id) => ids.has(id)));
}

/** Where a conversation's marks are kept: the room's session for a channel. */
function markKey(sessionId: string): string {
  return channelForSession(sessionId)?.sessionId ?? durableSessionId(sessionId);
}

/**
 * Move conversations to a project (or No project). Refused while a turn runs in any of them:
 * the working folder would change under a running tool call. A DM's move is a folder change.
 */
export function moveConversationsToProject(
  payload: HermesMoveToProjectPayload
): HermesMoveToProjectResult {
  const target = payload.projectId ? getStoredHermesProject(payload.projectId) : null;
  if (payload.projectId && !target) {
    return { success: false, moved: [], errorCode: 'not-found', error: 'That project no longer exists.' };
  }
  const sessionIds = [...new Set(payload.sessionIds.filter(Boolean))];
  if (sessionIds.some(isRunning)) {
    return {
      success: false,
      moved: [],
      errorCode: 'running',
      error: 'A reply is still running. Stop it or wait for it to finish, then move the chat.',
    };
  }

  const moved: HermesProjectMove[] = [];
  for (const sessionId of sessionIds) {
    const fromProjectId = conversationProjectId(sessionId);
    if (fromProjectId === (target?.id ?? null)) continue;
    const from = fromProjectId ? getStoredHermesProject(fromProjectId) : null;
    setConversationProjectId(idsFor(sessionId), target?.id ?? null);
    const mark = payload.quiet
      ? null
      : appendSessionProjectMark(markKey(sessionId), {
          kind: isStandingDm(sessionId) ? 'folder' : 'moved',
          fromProjectId,
          toProjectId: target?.id ?? null,
          ...(from ? { fromName: from.name } : {}),
          ...(target ? { toName: target.name, toPath: target.hostPath } : {}),
        });
    forgetAppliedFolder(sessionId);
    moved.push({
      sessionId,
      fromProjectId,
      toProjectId: target?.id ?? null,
      markId: mark?.id ?? '',
    });
  }
  return { success: true, moved };
}

/** Undo a move: back to where each conversation was, and its transcript mark removed. */
export function undoProjectMove(payload: HermesUndoProjectMovePayload): HermesMoveToProjectResult {
  if (payload.moves.some((m) => isRunning(m.sessionId))) {
    return {
      success: false,
      moved: [],
      errorCode: 'running',
      error: 'A reply is still running. Wait for it to finish, then undo.',
    };
  }
  for (const move of payload.moves) {
    const back =
      move.fromProjectId && getStoredHermesProject(move.fromProjectId) ? move.fromProjectId : null;
    setConversationProjectId(idsFor(move.sessionId), back);
    if (move.markId) removeSessionProjectMark(move.markId);
    forgetAppliedFolder(move.sessionId);
  }
  return { success: true, moved: [] };
}

export function listConversationProjectMarks(sessionId: string): SessionProjectMark[] {
  const seen = new Set<string>();
  const keys = [...new Set([markKey(sessionId), ...idsFor(sessionId)])];
  return keys
    .flatMap((key) => listSessionProjectMarks(key))
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// The folder last set on each live session, so a turn only sets it when it changed.
const appliedFolder = new Map<string, string>();
let defaultCwd: string | null = null;

function forgetAppliedFolder(sessionId: string): void {
  for (const id of idsFor(sessionId)) appliedFolder.delete(id);
}

/**
 * Before a turn: point the session at its own project's folder, or at the gateway's default
 * folder when it has none (ADR 0024 §2). Best effort: an older gateway without
 * `session.cwd.set` keeps whatever folder it had.
 */
export async function applyConversationFolder(
  sessionId: string,
  aliases: Array<string | null | undefined> = []
): Promise<void> {
  const known = [sessionId, ...aliases].filter((id): id is string => Boolean(id));
  const projectId =
    known.map((id) => storedProjectId(id)).find((id) => id !== undefined) ?? null;
  const project = projectId ? getStoredHermesProject(projectId) : null;
  try {
    const gateway = getHermesGatewaySession();
    let cwd = project?.containerPath ?? null;
    if (!cwd) {
      defaultCwd ??= await gateway.getDefaultCwd();
      cwd = defaultCwd;
    }
    if (appliedFolder.get(sessionId) === cwd) return;
    await gateway.setSessionCwd(sessionId, cwd);
    appliedFolder.set(sessionId, cwd);
  } catch (err) {
    console.warn('[hermesChatProjects] could not set the session folder', err);
  }
}

/** Test-only. */
export function resetHermesChatProjectsForTests(): void {
  appliedFolder.clear();
  defaultCwd = null;
}

