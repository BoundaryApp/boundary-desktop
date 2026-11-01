import { createHash, randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type {
  HermesChatBreakdownResult,
  AgentProfile,
  HermesChatCancelPayload,
  HermesChatCreateThreadResult,
  HermesChatBranchInfo,
  HermesChatBranchPayload,
  HermesChatBranchResult,
  HermesChatHistoryResult,
  HermesChatListThreadsResult,
  HermesChatMessage,
  HermesChatPhaseEvent,
  HermesChatRewindRequest,
  HermesChatStartPayload,
  HermesChatStartResult,
  HermesChatThreadSummary,
  HermesChatStartErrorCode,
  HermesChatToolEvent,
  HermesChatTurnStats,
  HermesConversationKind,
  HermesCreateHermesChatPayload,
  HermesOpenAgentDmPayload,
  HermesOpenAgentDmResult,
  HermesChatUsageSnapshot,
  HermesNoReply,
} from '../../../../shared/types/hermesChat';
import type { MessageCompletePayload } from './vendor/gateway-contract.generated';
import { BUILTIN_ASSISTANT_SLUG } from '../../../../shared/types/hermesChat';
import { BOUNDARY_SESSION_SOURCE, getHermesGatewaySession } from './hermesGatewaySession';
import { mapUsageSnapshot } from './hermesUsageMap';
import { extractPathsFromToolArgs } from '../../../../shared/hermesToolPaths';
import { ensureHermesWebuiSyncToInsights } from './hermesWebuiSync';
import { beginRunningTurn, endRunningTurn } from './hermesRunningTurns';
import { buildCodingAccessRequest } from '../coding/codingAccessRequests';
import {
  applyConversationFolder,
  conversationProjectId,
  fileThreads,
  setConversationProjectId,
} from './hermesChatProjects';
import { getActiveHermesProjectId } from './hermesProjectStore';
import {
  getWebuiSessionHistory,
  listWebuiSessions,
  mergeHermesThreadLists,
  webuiOnlySessionIds,
} from './hermesWebuiSessions';
import {
  annotateThreadsWithAgents,
  conversationKindFor,
  DM_HISTORY_BUDGET,
  historyBudgetFor,
  durableSessionId,
  readAgentSoul,
  resolveProfileForAgent,
} from './hermesAgents';
import {
  appendChannelPost,
  appendSessionSpeaker,
  consumeUnconsumedPosted,
  listChannelPosts,
  getSessionAgentSlug,
  getSessionSpeakers,
  getStoredAgent,
  listStoredAgents,
  migrateSessionInference,
  getSessionProjectId,
  copySessionInference,
  getSessionBranch,
  setSessionBranch,
  setChannelPostAssistantCount,
  setSessionAgentSlug,
  setSessionChannelId,
  getStandingDmSessionId,
  setStandingDmSessionId,
  getOrchestratorRecord,
  getRoomSoulSent,
  setRoomSoulSent,
  upsertStoredChannel,
  addFailedTurn,
  deleteFailedChat,
  getFailedChat,
  listFailedChats,
  replaceFailedTurn,
  setNoReply,
} from './hermesAgentStore';
import {
  buildChannelHeader,
  buildChannelWakePrompt,
  buildMemberSoulContext,
  buildOrchestratorRoomNote,
  channelForSession,
  mergeChannelTranscript,
  moveChannelSession,
  reconcileChannelSessions,
} from './hermesChannels';
import { parseMemberMentions } from '../../../../shared/hermesMentions';
import { inferenceSlotLabel } from '../../../../shared/inferenceDisplay';
import { newestFirst } from '../../../../shared/utils/sort';
import { ensureResolvedInferenceReady, noteFallbackServed, setSessionInferenceOverride } from './sessionInference';
import { lagLog } from '../../../perf/lagLog';
import { sendEvent as send } from '../../../ipc';
import { roundTenth } from '../../../../shared/lagProbe';
import { broadcastSessionsChanged, onHermesSessionsChanged } from './hermesSessionsChanged';
import {
  describeRewindError,
  planRewind,
  REWIND_UNSUPPORTED_MESSAGE,
  type RewindPlan,
} from './hermesRewind';
import {
  CONTINUE_PROMPT,
  recordNoReply,
  sessionSettled,
  settleInterruptedTurn,
  withFailedTurns,
  withReplyEndings,
} from './hermesReplyEndings';
import { getLastAppliedLlm } from '../AssistantStackStore';
import { parseRecoveryNotice } from './hermesRecoveryNotice';
import { logPostWithoutTurn, logTurnGate, startTurnLog, turnOutcome, type TurnLogFields } from './hermesTurnLog';

/**
 * Running turns by request id, with the chat ids each covers. Not tied to a window: a turn
 * finishes when the window that started it closes (decision D4), and any window can stop it.
 */
const activeStreams = new Map<string, { controller: AbortController; sessionIds: string[] }>();

const CONTINUE_UNSUPPORTED_MESSAGE =
  'Continue needs the local assistant stack, and is not available in channels.';
const localThreads = new Map<string, HermesChatThreadSummary>();
/** An agent's DM before its first send: a local id with no Hermes session yet (openAgentDm). */
const dmPlaceholderIds = new Set<string>();
/** Session ids that exist only in WebUI JSON (not in gateway state.db). */
const webuiOnlyThreadIds = new Set<string>();
/**
 * Chats made here that Hermes doesn't list yet: session.list leaves out a session with no
 * messages. Without this a new, empty chat drops out of the list on the next refresh, and
 * its composer chip can't file it (ADR 0024 §5). Dropped once Hermes lists the chat.
 */
const unlistedNewChats = new Map<string, HermesChatThreadSummary>();

/** The chat moved to another session, so its old stored id must not stay listed. */
function dropUnlistedChat(sessionId: string): void {
  unlistedNewChats.delete(sessionId);
  unlistedNewChats.delete(durableSessionId(sessionId));
}

function withUnlistedNewChats(
  sessions: HermesChatThreadSummary[],
  storedIdOf: (id: string) => string
): HermesChatThreadSummary[] {
  const listed = new Set(sessions.map((s) => storedIdOf(s.id)));
  const extra: HermesChatThreadSummary[] = [];
  for (const [id, thread] of unlistedNewChats) {
    if (listed.has(storedIdOf(id))) unlistedNewChats.delete(id);
    else extra.push(thread);
  }
  return [...extra, ...sessions];
}

/**
 * Chats that exist only as Boundary's record of a failed send. A chat Hermes also lists keeps
 * its row, with the record's title if Hermes hasn't given it one.
 */
function withFailedChats(
  sessions: HermesChatThreadSummary[],
  storedIdOf: (id: string) => string
): HermesChatThreadSummary[] {
  const failed = listFailedChats();
  const listed = new Set(sessions.map((s) => storedIdOf(s.id)));
  const extra = Object.entries(failed)
    .filter(([id]) => !listed.has(storedIdOf(id)))
    .map(([id, chat]): HermesChatThreadSummary => ({
      id,
      title: chat.title,
      createdAt: chat.turns[0]?.at,
      updatedAt: chat.turns.at(-1)?.at,
      source: 'boundary',
      agentSlug: chat.agentSlug,
      failed: true,
    }));
  const titled = sessions.map((s) => {
    const title = s.title === 'New chat' ? failed[storedIdOf(s.id)]?.title : undefined;
    return title ? { ...s, title } : s;
  });
  return [...extra, ...titled];
}

function titleFromMessages(messages: HermesChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')?.content?.trim();
  if (!firstUser) return 'New chat';
  return firstUser.length > 48 ? `${firstUser.slice(0, 48)}…` : firstUser;
}

function rememberThread(thread: HermesChatThreadSummary): void {
  localThreads.set(thread.id, thread);
}

function sendPhase(sender: WebContents, event: HermesChatPhaseEvent): void {
  send(sender, 'hermes-chat:phase', event);
}

function sendTool(sender: WebContents, event: HermesChatToolEvent): void {
  send(sender, 'hermes-chat:tool', event);
}

function sendTurnStats(sender: WebContents, event: HermesChatTurnStats): void {
  send(sender, 'hermes-chat:turn-stats', event);
}

async function gateResolvedInference(
  sender: WebContents,
  requestId: string,
  sessionId: string | undefined
): Promise<{ blocked: HermesChatStartResult | null; restarted: boolean }> {
  const gateStartedAt = Date.now();
  let restarted = false;
  let sharedWasUnavailable = false;
  const ready = await ensureResolvedInferenceReady(sessionId, (resolved, sharedUnavailable, restarting) => {
    restarted ||= restarting;
    sharedWasUnavailable = sharedUnavailable;
    // Most applies don't restart Hermes and take moments, so they say nothing of their own.
    if (!restarting && !sharedUnavailable) return;
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: restarting ? 'restarting' : 'preparing',
      toolName: resolved.slot === 'peer' ? resolved.providerDisplayName : inferenceSlotLabel(resolved.slot),
      ...(sharedUnavailable ? { sharedUnavailable } : {}),
    });
  });
  logTurnGate({
    requestId,
    sessionId,
    ms: Date.now() - gateStartedAt,
    restarted,
    sharedUnavailable: sharedWasUnavailable,
    blocked: !ready.ok,
  });
  if (ready.ok === true) return { blocked: null, restarted };
  return {
    restarted,
    blocked: {
      success: false,
      requestId,
      sessionId,
      error: ready.error,
      errorCode: ready.errorCode,
      ...(ready.sharedUnavailable ? { sharedUnavailable: true } : {}),
      ...(ready.provider ? { provider: ready.provider } : {}),
    },
  };
}

/** Hermes events the turn log tracks. Their payloads are never logged. */
const TURN_LOGGED_EVENTS = [
  'message.delta',
  'message.complete',
  'session.usage',
  'status.update',
  'turn.heartbeat',
  'tool.start',
  'tool.complete',
  'error',
];

/**
 * How long a turn may go without a Hermes event before Boundary asks whether it is still
 * running, on a gateway that sends no `turn.heartbeat`.
 */
export const TURN_QUIET_MS = 3 * 60 * 1000;
/** Missed `turn.heartbeat` intervals before Boundary asks, on a gateway that sends them. */
const TURN_QUIET_HEARTBEATS = 2.5;
/** Unanswered status checks in a row before a quiet turn is given up on. */
const TURN_QUIET_CHECK_FAILURES = 2;

/** `prompt.submit` with `context` while a turn runs (stack v0.3.3 client-context overlay). */
const CONTEXT_TURN_RUNNING = 4082;

async function runJsonRpcTurn(
  sender: WebContents,
  requestId: string,
  sessionId: string,
  userText: string,
  signal: AbortSignal,
  toolsEnabled: boolean,
  opts?: {
    profile?: string | null;
    agentSlug?: string | null;
    /** When false, skip sending hermes-chat:end (multi-turn channel wake). */
    emitEnd?: boolean;
    /** Edit / Retry: replace history from this durable user row onward. */
    truncate?: { rowId: number; confirmEmpty: boolean };
    /** Continue: the prompt is Boundary's instruction, stored hidden. */
    displayKind?: 'hidden';
    /** Where to record who spoke; a room's stored id rather than the runtime id. */
    speakerKey?: string;
    /**
     * Turn context for the model (a room's header), sent as `prompt.submit`'s `context`.
     * Put above the message text only when Hermes refuses it because a turn is running (4082).
     */
    context?: string;
    /** What the turn's debug-log lines say about it. */
    log?: TurnLogFields;
  }
): Promise<{ assistantText: string; noReply?: HermesNoReply }> {
  const gateway = getHermesGatewaySession();
  await gateway.ensureConnected();
  // A turn stopped just before this one may still be winding down on Hermes; a submit
  // now would land on a busy session and be redirected or queued instead of run.
  await sessionSettled(sessionId);

  const turnLog = startTurnLog(
    requestId,
    sessionId,
    opts?.log ?? {
      kind: 'hermes',
      trigger: 'sent',
      agent: opts?.agentSlug ?? null,
      profile: opts?.profile ?? null,
    }
  );
  let ended = false;
  let visibleTokens = 0;
  let toolTurn = 0;
  let maxTurns: number | null = null;
  const startedAt = Date.now();
  let firstEventAt: number | null = null;
  let latestUsage: HermesChatUsageSnapshot | undefined;
  let resolveTurn: (() => void) | null = null;
  let assistantText = '';
  let noReply: HermesNoReply | undefined;
  let lastEvent: string | null = null;
  let lastEventAt: number | null = null;
  let hermesErrors = 0;
  // Hermes's recovery ladder: which rung, and when it tries the provider again.
  let recovery: { cycle: number; total: number; until: number; provider?: string } | null = null;
  const emitEnd = opts?.emitEnd !== false;
  const profile = opts?.profile ?? null;
  const agentSlug = opts?.agentSlug ?? null;

  try {
    maxTurns = await gateway.getMaxTurns(profile);
  } catch {
    maxTurns = null;
  }

  // With heartbeats, a quiet spell of about two missed beats means the stream was lost.
  let quietMs = TURN_QUIET_MS;
  try {
    const { heartbeatS } = await gateway.getTurnLiveness();
    if (heartbeatS != null) quietMs = Math.round(heartbeatS * TURN_QUIET_HEARTBEATS * 1000);
  } catch {
    /* optional: keep the plain quiet window */
  }

  try {
    await gateway.applyToolsEnabled(sessionId, toolsEnabled);
  } catch {
    /* optional */
  }

  const recoveryField = () => {
    if (!recovery) return {};
    const { until, ...rung } = recovery;
    return { recovery: { ...rung, retryInSec: Math.max(0, Math.ceil((until - Date.now()) / 1000)) } };
  };

  const markFirstEvent = () => {
    if (firstEventAt == null) firstEventAt = Date.now();
  };

  const endOnce = (finishReason?: string, complete?: MessageCompletePayload) => {
    if (ended) return;
    ended = true;
    if (visibleTokens === 0) {
      noReply = noReplyFor(finishReason, complete, signal);
    }
    // `message.complete` sends its own; without this a stopped turn stays on its last phase.
    if (finishReason !== 'stop') sendPhase(sender, { requestId, sessionId, phase: 'done' });
    const ttftSec =
      firstEventAt != null ? (firstEventAt - startedAt) / 1000 : null;
    turnLog.end({
      ...turnOutcome(finishReason, complete, signal),
      firstEventAt,
      visibleTokens,
      toolCalls: toolTurn,
      lastEvent,
      lastEventMsAgo: lastEventAt != null ? Date.now() - lastEventAt : null,
      hermesErrors,
    });
    sendTurnStats(sender, {
      requestId,
      sessionId,
      prompt: latestUsage?.prompt ?? null,
      generated: latestUsage?.completion ?? null,
      visible: visibleTokens > 0 ? visibleTokens : null,
      ttftSec,
      avgTps: latestUsage?.avgTps ?? null,
    });
    if (emitEnd) {
      send(sender, 'hermes-chat:end', {
        requestId,
        sessionId,
        finishReason,
        ...(noReply ? { noReply } : {}),
      });
    }
    resolveTurn?.();
  };

  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  // A slow local model can run a turn for far longer than any fixed cap, and an unpatched
  // Hermes sends nothing while one long model call is in flight. So a quiet turn only ends
  // once Hermes itself says the session is no longer working (or stops answering).
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let failedChecks = 0;
  const checkQuiet = async () => {
    quietTimer = null;
    if (ended || signal.aborted) return;
    let status: string | null = null;
    let keep: boolean;
    try {
      status = await gateway.getLiveStatus(sessionId, profile);
      failedChecks = 0;
      keep = status != null && status !== 'idle';
    } catch {
      failedChecks += 1;
      keep = failedChecks < TURN_QUIET_CHECK_FAILURES;
    }
    if (ended || signal.aborted) return;
    lagLog(
      {
        proc: 'main',
        kind: 'turn-quiet',
        requestId,
        status,
        failedChecks,
        elapsedS: Math.round((Date.now() - startedAt) / 1000),
        outcome: keep ? 'still-running' : 'ended',
      },
      true
    );
    turnLog.note('turn quiet check', { status, failedChecks, keep, lastEvent });
    if (keep) armQuiet();
    else endOnce('timeout');
  };
  const armQuiet = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = ended ? null : setTimeout(() => void checkQuiet(), quietMs);
  };

  // Stopped during the set-up above: nothing reached Hermes, and the abort listener below
  // would never fire for a signal that has already aborted.
  if (signal.aborted) {
    endOnce('cancel');
    return { assistantText, ...(noReply ? { noReply } : {}) };
  }

  // Which Hermes event a turn saw last, so a stuck turn's log says where it stopped.
  const unsubSeen = TURN_LOGGED_EVENTS.map((name) =>
    gateway.on(name, (event) => {
      if (event.session_id && event.session_id !== sessionId) return;
      lastEvent = name;
      lastEventAt = Date.now();
      if (name === 'error') {
        hermesErrors += 1;
        turnLog.note('turn hermes error event', { visibleTokens });
      }
    })
  );

  if (agentSlug) {
    send(sender, 'hermes-chat:speaker', {
      requestId,
      sessionId,
      agentSlug,
    });
  }

  sendPhase(sender, {
    requestId,
    sessionId,
    phase: 'preparing',
    elapsedSec: 0,
    maxTurns: maxTurns ?? undefined,
  });

  const unsubDelta = gateway.on('message.delta', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    const payload = event.payload as { text?: string } | undefined;
    const delta = payload?.text ?? '';
    if (!delta) return;
    recovery = null;
    markFirstEvent();
    assistantText += delta;
    visibleTokens += delta.length > 0 ? Math.max(1, Math.ceil(delta.length / 4)) : 0;
    send(sender, 'hermes-chat:chunk', { requestId, delta, agentSlug });
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'generating',
      visibleTokens,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage: latestUsage,
    });
  });

  const unsubComplete = gateway.on('message.complete', (event) => {
    if (event.session_id && event.session_id !== sessionId) return;
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'done',
      visibleTokens,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage: latestUsage,
    });
    endOnce('stop', event.payload as MessageCompletePayload | undefined);
  });

  const unsubUsage = gateway.on('session.usage', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    const payload = event.payload as { usage?: Record<string, unknown> } | undefined;
    const usage: HermesChatUsageSnapshot | undefined = payload?.usage
      ? mapUsageSnapshot(payload.usage)
      : undefined;
    if (usage) latestUsage = usage;
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: visibleTokens > 0 && !recovery ? 'generating' : 'preparing',
      visibleTokens,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage,
      ...recoveryField(),
    });
  });

  const unsubStatus = gateway.on('status.update', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    const notice = parseRecoveryNotice(event.payload);
    if (!notice) return;
    const applied = getLastAppliedLlm();
    recovery = {
      cycle: notice.cycle,
      total: notice.total,
      until: Date.now() + notice.retryInSec * 1000,
      ...(applied && !applied.routed
        ? { provider: applied.slot === 'local' ? 'Your local model' : inferenceSlotLabel(applied.slot) }
        : {}),
    };
    turnLog.note('turn recovery wait', { cycle: notice.cycle, total: notice.total, waitS: notice.retryInSec });
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'preparing',
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage: latestUsage,
      ...recoveryField(),
    });
  });

  // The model is answering after a wait; its thinking comes before any text.
  const unsubReasoning = gateway.on('reasoning.delta', (event) => {
    if (event.session_id && event.session_id !== sessionId) return;
    recovery = null;
  });

  // Hermes ends a turn idle for too long itself, so a heartbeat only says the stream is alive.
  const unsubHeartbeat = gateway.on('turn.heartbeat', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
  });

  const unsubToolStart = gateway.on('tool.start', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    recovery = null;
    markFirstEvent();
    toolTurn += 1;
    const payload = event.payload as {
      tool_id?: string;
      name?: string;
      args?: Record<string, unknown> | null;
    } | undefined;
    const toolId = payload?.tool_id ?? `tool-${toolTurn}`;
    const name = payload?.name ?? 'tool';
    const args = payload?.args ?? undefined;
    const paths = extractPathsFromToolArgs(args ?? null);
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'tool',
      toolName: name,
      toolTurn,
      maxTurns: maxTurns ?? undefined,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      usage: latestUsage,
    });
    sendTool(sender, {
      requestId,
      sessionId,
      toolId,
      name,
      status: 'running',
      turn: toolTurn,
      maxTurns: maxTurns ?? undefined,
      args: args ?? undefined,
      paths,
    });
  });

  const unsubToolGenerating = gateway.on('tool.generating', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    const payload = event.payload as { name?: string } | undefined;
    sendTool(sender, {
      requestId,
      sessionId,
      toolId: `generating-${payload?.name ?? 'tool'}`,
      name: payload?.name ?? 'tool',
      status: 'generating',
      turn: toolTurn || undefined,
      maxTurns: maxTurns ?? undefined,
    });
  });

  const unsubToolComplete = gateway.on('tool.complete', (event) => {
    if (signal.aborted || ended) return;
    if (event.session_id && event.session_id !== sessionId) return;
    armQuiet();
    const payload = event.payload as {
      tool_id?: string;
      name?: string;
      args?: Record<string, unknown> | null;
      duration_s?: number | null;
      summary?: string | null;
      result_text?: string | null;
    } | undefined;
    const toolId = payload?.tool_id ?? `tool-${toolTurn}`;
    const name = payload?.name ?? 'tool';
    const args = payload?.args ?? undefined;
    const paths = extractPathsFromToolArgs(args ?? null);
    sendTool(sender, {
      requestId,
      sessionId,
      toolId,
      name,
      status: 'done',
      turn: toolTurn || undefined,
      maxTurns: maxTurns ?? undefined,
      args: args ?? undefined,
      summary: payload?.summary ?? payload?.result_text ?? undefined,
      result: payload?.result_text ?? undefined,
      durationSec:
        typeof payload?.duration_s === 'number' ? payload.duration_s : undefined,
      paths,
    });
    // A coding task outside the coding folders: ask the user, don't hint at make (ADR 0028 §9).
    const access = buildCodingAccessRequest({
      toolName: name,
      resultText: payload?.result_text ?? payload?.summary ?? null,
      args: args ?? null,
      sessionId,
      requestId,
      projectId: conversationProjectId(sessionId),
    });
    if (access) send(sender, 'coding-folders:access-request', access);
  });

  const onAbort = () => {
    if (!ended) {
      settleInterruptedTurn(
        sessionId,
        signal.reason === 'interrupted' ? 'interrupted' : 'stopped',
        assistantText.trim().length > 0
      );
    }
    void gateway.cancelPrompt(sessionId);
    endOnce('cancel');
  };
  signal.addEventListener('abort', onAbort);

  const preparingTicker = setInterval(() => {
    if (ended || signal.aborted || (visibleTokens > 0 && !recovery)) return;
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'preparing',
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage: latestUsage,
      ...recoveryField(),
    });
  }, 1000);

  armQuiet();

  try {
    const submitOpts = {
      truncate: opts?.truncate,
      ...(opts?.displayKind ? { displayKind: opts.displayKind } : {}),
    };
    const context = opts?.context;
    if (context) {
      try {
        await gateway.submitPrompt(sessionId, userText, { ...submitOpts, context });
      } catch (err) {
        // 4082: a turn is still running, and context can't be queued. Send it inline instead.
        if ((err as { code?: unknown })?.code !== CONTEXT_TURN_RUNNING) throw err;
        await gateway.submitPrompt(sessionId, `${context}\n\n${userText}`, submitOpts);
      }
    } else {
      await gateway.submitPrompt(sessionId, userText, submitOpts);
    }
    if (!ended && !signal.aborted) {
      await turnDone;
    }
  } catch (err) {
    turnLog.end({ outcome: 'failed', error: err, visibleTokens, toolCalls: toolTurn });
    throw err;
  } finally {
    if (quietTimer) clearTimeout(quietTimer);
    clearInterval(preparingTicker);
    signal.removeEventListener('abort', onAbort);
    for (const unsub of unsubSeen) unsub();
    unsubDelta();
    unsubComplete();
    unsubUsage();
    unsubHeartbeat();
    unsubStatus();
    unsubReasoning();
    unsubToolStart();
    unsubToolGenerating();
    unsubToolComplete();
  }

  if (agentSlug && assistantText.trim()) {
    appendSessionSpeaker(opts?.speakerKey ?? sessionId, agentSlug);
  }

  return { assistantText, ...(noReply ? { noReply } : {}) };
}

/** Why a turn that streamed no text ended, from how it ended and Hermes's completion. */
export function noReplyFor(
  finishReason: string | undefined,
  complete: MessageCompletePayload | undefined,
  signal: AbortSignal
): HermesNoReply {
  if (finishReason === 'cancel') {
    return { reason: signal.reason === 'interrupted' ? 'interrupted' : 'stopped' };
  }
  if (finishReason === 'timeout') return { reason: 'timeout' };
  const error = [complete?.error, complete?.failure_reason].find(
    (e): e is string => typeof e === 'string' && e.trim().length > 0
  );
  if (complete?.status === 'error') return { reason: 'failed', ...(error ? { error } : {}) };
  if (complete?.status === 'interrupted') return { reason: 'halted' };
  return { reason: 'empty' };
}

/** Re-read the transcript right before an Edit / Retry cut and plan against it. */
async function planRewindForSession(
  sessionId: string,
  request: HermesChatRewindRequest
): Promise<RewindPlan> {
  try {
    const history = await getHermesGatewaySession().getSessionHistory(sessionId);
    return planRewind(history, request);
  } catch {
    return { kind: 'refuse', code: 'rewind-unsupported', error: REWIND_UNSUPPORTED_MESSAGE };
  }
}

function resolveChannel(sessionId: string | null | undefined) {
  return channelForSession(sessionId);
}

function touchChannelUpdatedAt(channel: NonNullable<ReturnType<typeof resolveChannel>>): void {
  upsertStoredChannel({
    ...channel,
    updatedAt: new Date().toISOString(),
  });
}

async function runChannelWakeTurns(
  sender: WebContents,
  requestId: string,
  sessionId: string,
  userText: string,
  signal: AbortSignal,
  toolsEnabled: boolean,
  memberSlugs: string[],
  wakeSlugs: string[],
  /** The room's stored id: posts and speakers are kept there, not under the runtime id. */
  roomKey: string = sessionId,
  channelSlug: string = 'room'
): Promise<void> {
  const agents = listStoredAgents();
  const members = agents.filter((a) => memberSlugs.includes(a.slug));
  const backlog = consumeUnconsumedPosted(roomKey);

  let first = true;
  let lastSpeaker: Pick<AgentProfile, 'displayName' | 'handle'> | null = null;
  const spoken = new Set<string>();
  const queue = [...wakeSlugs];
  const mentioned = new Set(wakeSlugs);

  while (queue.length > 0 && !signal.aborted) {
    const slug = queue.shift()!;
    if (spoken.has(slug)) continue;
    spoken.add(slug);
    const agent = getStoredAgent(slug) ?? members.find((m) => m.slug === slug);
    const display = agent?.displayName ?? slug;
    const isFirst = first;
    first = false;
    const speaker = agent ?? { displayName: display, handle: display };
    const header = buildChannelHeader(channelSlug, members, speaker, isFirst ? null : lastSpeaker);
    const promptText = isFirst
      ? buildChannelWakePrompt(backlog, userText)
      : `@${display} — please respond to the room.`;
    const soul = readAgentSoul(slug);
    const soulHash = soul ? createHash('sha256').update(soul).digest('hex').slice(0, 16) : null;
    const soulIsNew = soulHash !== null && getRoomSoulSent(roomKey, slug) !== soulHash;
    const context = [
      header,
      ...(soul ? [buildMemberSoulContext(speaker, soulIsNew ? soul : null)] : []),
      ...(getOrchestratorRecord()?.slug === slug ? [buildOrchestratorRoomNote(speaker)] : []),
    ].join('\n\n');

    const { assistantText } = await runJsonRpcTurn(
      sender,
      requestId,
      sessionId,
      promptText,
      signal,
      toolsEnabled,
      {
        // The room's session belongs to the default profile, so every member's turn runs
        // there; the agent's profile would also hide the turn from session.live_status.
        profile: null,
        agentSlug: slug,
        emitEnd: false,
        // Chunks carry agentSlug; the renderer starts a new speaker's section from it.
        speakerKey: roomKey,
        context,
        log: {
          kind: 'channel',
          trigger: mentioned.has(slug) ? 'woken' : 'chain-woken',
          agent: slug,
          profile: null,
          speaker: slug,
        },
      }
    );
    if (soulIsNew && soulHash) setRoomSoulSent(roomKey, slug, soulHash);

    lastSpeaker = speaker;
    // Chain-wake: parse reply for other members (not the speaker).
    const next = parseMemberMentions(assistantText, members).filter(
      (s) => s !== slug && !spoken.has(s) && !queue.includes(s)
    );
    queue.push(...next);
  }

  send(sender, 'hermes-chat:end', { requestId, sessionId, finishReason: 'stop' });
}

/**
 * The last list the gateway gave. A call that fails reuses it, so those chats don't drop
 * out of the rail until the next refresh.
 */
let lastGatewaySessions: HermesChatThreadSummary[] | null = null;

/**
 * WebUI's list (all its chats, ~0.5MB). WebUI rebuilds it after every session change, which
 * can take over a second, so only the first chat list waits for it. Later lists use this
 * copy and refresh it in the background after Hermes says sessions changed, or once it is
 * a minute old; a refresh that brings anything new asks the windows to list again. A
 * failed or timed-out refresh keeps the copy.
 */
const WEBUI_MAX_AGE_MS = 60_000;
/** After sessions.changed, refresh at most this often (they come in bursts during replies). */
const WEBUI_CHANGED_MIN_AGE_MS = 10_000;
let webuiCache: { list: HermesChatThreadSummary[]; fetchedAt: number } | null = null;
let webuiChanged = false;
let webuiFetch: Promise<HermesChatThreadSummary[] | null> | null = null;

onHermesSessionsChanged(() => {
  webuiChanged = true;
});

function fetchWebuiList(): Promise<HermesChatThreadSummary[] | null> {
  if (webuiFetch) return webuiFetch;
  // Cleared at the start, so a change during the fetch asks for another one.
  webuiChanged = false;
  webuiFetch = listWebuiSessions()
    .then((list) => {
      if (list) webuiCache = { list, fetchedAt: Date.now() };
      return list;
    })
    .finally(() => {
      webuiFetch = null;
    });
  return webuiFetch;
}

function webuiSignature(list: HermesChatThreadSummary[]): string {
  return JSON.stringify(list.map((t) => [t.id, t.title, t.updatedAt, t.cwd]));
}

/** WebUI's chats for one chat list: waits only when there is no copy yet. */
async function webuiSessionsForList(
  timing: Record<string, unknown>
): Promise<HermesChatThreadSummary[] | null> {
  if (!webuiCache) {
    const started = performance.now();
    const list = await fetchWebuiList();
    timing.webuiMs = roundTenth(performance.now() - started);
    return list;
  }
  const cached = webuiCache;
  const age = Date.now() - cached.fetchedAt;
  timing.webuiAgeS = Math.round(age / 1000);
  if (!webuiFetch && (age > WEBUI_MAX_AGE_MS || (webuiChanged && age > WEBUI_CHANGED_MIN_AGE_MS))) {
    timing.webuiRefresh = webuiChanged ? 'changed' : 'age';
    const started = performance.now();
    void fetchWebuiList().then((list) => {
      const changed = Boolean(list) && webuiSignature(list!) !== webuiSignature(cached.list);
      lagLog({
        proc: 'main',
        kind: 'webui-list-refresh',
        ms: roundTenth(performance.now() - started),
        webui: list?.length ?? null,
        changed,
      });
      if (changed) broadcastSessionsChanged();
    });
  }
  return cached.list;
}

/**
 * One list at a time. The 12s refresh and sessions.changed bursts used to stack dozens of
 * lists. A call made while one runs waits for a single follow-up list that starts after it,
 * so it never gets a result fetched before a change it just made.
 */
let listing: Promise<HermesChatListThreadsResult> | null = null;
let queuedListing: Promise<HermesChatListThreadsResult> | null = null;

export function listHermesChatThreads(): Promise<HermesChatListThreadsResult> {
  if (!listing) {
    listing = listHermesChatThreadsOnce().finally(() => {
      listing = null;
    });
    return listing;
  }
  queuedListing ??= listing.then(
    () => {
      queuedListing = null;
      return listHermesChatThreads();
    },
    () => {
      queuedListing = null;
      return listHermesChatThreads();
    }
  );
  return queuedListing;
}

async function listHermesChatThreadsOnce(): Promise<HermesChatListThreadsResult> {
  const t0 = performance.now();
  const timing: Record<string, unknown> = {};
  const since = (from: number) => roundTenth(performance.now() - from);
  try {
    // Best-effort: project WebUI JSON chats into state.db so session.list sees them.
    ensureHermesWebuiSyncToInsights();
  } catch {
    /* optional */
  }
  timing.webuiSyncMs = since(t0);

  try {
    const gateway = getHermesGatewaySession();
    const fetched = performance.now();
    const [gatewayListed, webuiListed] = await Promise.all([
      gateway
        .listSessions()
        .then((list) => {
          timing.gatewayMs = since(fetched);
          return list;
        })
        .catch((err: unknown): null => {
          timing.gatewayMs = since(fetched);
          timing.gatewayError = err instanceof Error ? err.message : String(err);
          return null;
        }),
      webuiSessionsForList(timing),
    ]);
    if (gatewayListed) lastGatewaySessions = gatewayListed;
    timing.gatewayStale = !gatewayListed && Boolean(lastGatewaySessions);
    timing.gateway = gatewayListed?.length ?? null;
    timing.webui = webuiListed?.length ?? null;
    const gatewaySessions = gatewayListed ?? lastGatewaySessions ?? [];
    const webuiSessions = webuiListed ?? [];
    // Rooms that still hold a dead runtime id move to their stored session. Only with a
    // real list: an empty one from a failed call would look like every room is gone.
    if (gatewayListed) {
      reconcileChannelSessions(gatewayListed, (id) => gateway.storedSessionId(id));
    }

    // When gateway.listSessions succeeds (even empty), merge with WebUI.
    const merged = performance.now();
    const storedIdOf = (id: string) => gateway.storedSessionId(id);
    const sessions = withFailedChats(
      withUnlistedNewChats(mergeHermesThreadLists(gatewaySessions, webuiSessions), storedIdOf),
      storedIdOf
    );
    const onlyWebui = webuiOnlySessionIds(gatewaySessions, webuiSessions);
    webuiOnlyThreadIds.clear();
    for (const id of onlyWebui) webuiOnlyThreadIds.add(id);

    localThreads.clear();
    for (const s of sessions) {
      rememberThread(s);
    }
    const threads = fileThreads(annotateThreadsWithAgents(withBranchInfo(sessions)));
    timing.mergeMs = since(merged);
    lagLog({
      proc: 'main',
      kind: 'chat-list-timing',
      ms: since(t0),
      threads: threads.length,
      ...timing,
    });
    return { success: true, threads };
  } catch (err) {
    // Gateway and WebUI failures are caught above, so this is a bug in Boundary's own code.
    return { success: false, threads: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function withBranchInfo(threads: HermesChatThreadSummary[]): HermesChatThreadSummary[] {
  return threads.map((thread) => {
    const branch = getSessionBranch(thread.id);
    return branch ? { ...thread, branch } : thread;
  });
}

/**
 * Branch: a new chat seeded with the visible messages up to the cut (text only until
 * upstream can fork at a row, CR 0001 R2). It keeps the parent's agent and chat
 * inference override. It is never a standing DM: a Hermes chat when the parent was one,
 * otherwise a side chat with the parent's agent (ADR 0023).
 */
export async function branchHermesChat(
  payload: HermesChatBranchPayload
): Promise<HermesChatBranchResult> {
  const seed = payload.seed.filter((m) => m.content.trim().length > 0);
  if (!payload.parentSessionId || seed.length === 0) {
    return { success: false, error: 'Nothing to branch from yet.' };
  }
  const agentSlug =
    payload.agentSlug?.trim() ||
    getSessionAgentSlug(payload.parentSessionId) ||
    BUILTIN_ASSISTANT_SLUG;
  const parentTitle = payload.parentTitle?.trim() || titleFromMessages(seed);
  const title = `${parentTitle} · branch`;
  try {
    const gateway = getHermesGatewaySession();
    // Lineage must name the parent's stored row; Boundary often holds its runtime id.
    const parentStoredId = gateway.storedSessionId(payload.parentSessionId);
    const runtimeId = await gateway.createSessionWithSeed({
      title,
      messages: seed.map((m) => ({ role: m.role, content: m.content })),
      profile: resolveProfileForAgent(agentSlug),
      parentSessionId: parentStoredId,
    });
    // Open the branch by its stored id: resume finds the seeded row (or reuses the live
    // session), and it is the id later session lists use.
    const id = gateway.storedSessionId(runtimeId);
    const branch: HermesChatBranchInfo = {
      parentId: parentStoredId,
      parentTitle,
      seededCount: seed.length,
      branchedAt: new Date().toISOString(),
    };
    for (const key of new Set([id, runtimeId])) {
      setSessionAgentSlug(key, agentSlug);
      copySessionInference(payload.parentSessionId, key);
      setSessionBranch(key, branch);
    }
    // A branch starts where its parent lives; a DM's side chat, in the DM's folder (0024).
    const projectId = conversationProjectId(payload.parentSessionId);
    setConversationProjectId([id, runtimeId], projectId);
    const thread: HermesChatThreadSummary = {
      id,
      title,
      updatedAt: branch.branchedAt,
      createdAt: branch.branchedAt,
      source: 'boundary',
      agentSlug,
      kind: agentSlug === BUILTIN_ASSISTANT_SLUG ? 'hermes' : 'side',
      branch,
      projectId,
    };
    rememberThread(thread);
    return { success: true, thread };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Could not create the branch.',
    };
  }
}

/**
 * A send that had no gateway session yet (or only an offline placeholder) just got one.
 * A personality without a DM claims it as its DM; one replacing its placeholder DM moves the
 * pointer. Anything else keeps its kind: a Hermes chat, or a side chat (ADR 0023).
 */
export function claimNewSession(
  agentSlug: string,
  sessionId: string,
  replacing?: string
): HermesConversationKind {
  // Its stored id is what lists and the DM pointer use; record the agent under it too.
  const stored = durableSessionId(sessionId);
  if (stored !== sessionId) setSessionAgentSlug(stored, agentSlug);
  if (willClaimDm(agentSlug, replacing)) {
    setStandingDmSessionId(agentSlug, stored);
  }
  return conversationKindFor(sessionId, agentSlug);
}

/** Whether a new session for this agent (replacing `replacing`) will become its DM. */
function willClaimDm(agentSlug: string, replacing?: string): boolean {
  if (agentSlug === BUILTIN_ASSISTANT_SLUG) return false;
  const standing = getStandingDmSessionId(agentSlug);
  return !standing || (!!replacing && (standing === replacing || standing === durableSessionId(replacing)));
}

/** Session options for a send that starts an agent's session: a DM gets its history budget. */
function newSessionOpts(
  agentSlug: string,
  profile: string | null,
  replacing?: string
): { profile: string | null; historyBudget?: number } {
  return willClaimDm(agentSlug, replacing)
    ? { profile, historyBudget: DM_HISTORY_BUDGET }
    : { profile };
}

/**
 * A new titled chat with the built-in agent, filed under `projectId` (the rail's project).
 * Never touches any DM (ADR 0023, 0024).
 */
export async function createHermesChat(
  payload: HermesCreateHermesChatPayload = {}
): Promise<HermesChatCreateThreadResult> {
  const agentSlug = BUILTIN_ASSISTANT_SLUG;
  const projectId = payload.projectId ?? null;
  try {
    const gateway = getHermesGatewaySession();
    // 'New chat' is only a placeholder: Hermes titles the chat from its first turn, and
    // refuses a title another session already holds.
    const runtimeId = await gateway.createSessionWithSeed({ profile: null });
    const id = durableSessionId(runtimeId);
    for (const key of new Set([id, runtimeId])) setSessionAgentSlug(key, agentSlug);
    setConversationProjectId([id, runtimeId], projectId);
    const now = new Date().toISOString();
    const thread: HermesChatThreadSummary = {
      id,
      title: 'New chat',
      updatedAt: now,
      createdAt: now,
      source: 'boundary',
      agentSlug,
      kind: 'hermes',
      projectId,
    };
    rememberThread(thread);
    unlistedNewChats.set(id, thread);
    return { success: true, thread };
  } catch (err) {
    return { success: false, error: unreachableError(agentSlug, err) };
  }
}

/**
 * A personality's one ongoing DM (ADR 0023). Returns the standing session when Hermes still has
 * it. A standing id Hermes can't find (an empty session it never stored) is repaired: the
 * agent's newest real conversation becomes its DM, or else a placeholder that the first send
 * turns into a session (claimNewSession), so no empty session is made up front.
 */
export async function openAgentDm(
  payload: HermesOpenAgentDmPayload
): Promise<HermesOpenAgentDmResult> {
  const agentSlug = payload.agentSlug?.trim();
  if (!agentSlug) return { success: false, error: 'Missing agent.' };
  if (agentSlug === BUILTIN_ASSISTANT_SLUG) {
    return { success: false, error: 'The built-in agent has chats, not a DM.' };
  }
  const agent = getStoredAgent(agentSlug);
  if (!agent) return { success: false, error: 'That agent no longer exists.' };

  const standing = getStandingDmSessionId(agentSlug);
  // A placeholder is an empty DM: the agent's real conversation, if it has one, comes first.
  const placeholder = standing ? dmPlaceholderIds.has(standing) : false;
  if (standing && !placeholder && !(await isMissingSession(standing, agentSlug))) {
    const known = localThreads.get(standing);
    return {
      success: true,
      created: false,
      thread: {
        ...(known ?? { id: standing, title: agent.displayName }),
        agentSlug,
        kind: 'dm',
        projectId: conversationProjectId(standing),
      },
    };
  }

  if (standing) {
    const newest = await newestAgentConversation(agentSlug, standing);
    if (newest) {
      setSessionAgentSlug(newest.id, agentSlug);
      setStandingDmSessionId(agentSlug, durableSessionId(newest.id));
      const thread: HermesChatThreadSummary = { ...newest, agentSlug, kind: 'dm' };
      rememberThread(thread);
      return { success: true, created: false, thread };
    }
    if (placeholder) {
      const known = localThreads.get(standing);
      return {
        success: true,
        created: false,
        thread: {
          ...(known ?? { id: standing, title: `DM · ${agent.displayName}` }),
          agentSlug,
          kind: 'dm',
          projectId: conversationProjectId(standing),
        },
      };
    }
  }

  const id = randomUUID();
  dmPlaceholderIds.add(id);
  setSessionAgentSlug(id, agentSlug);
  setStandingDmSessionId(agentSlug, id);
  // A new DM starts working in the folder the user is looking at (ADR 0024 §7).
  const projectId = payload.projectId ?? null;
  setConversationProjectId([id], projectId);
  const now = new Date().toISOString();
  const thread: HermesChatThreadSummary = {
    id,
    title: `DM · ${agent.displayName}`,
    updatedAt: now,
    createdAt: now,
    source: 'boundary',
    agentSlug,
    kind: 'dm',
    projectId,
  };
  rememberThread(thread);
  return { success: true, created: true, thread };
}

/** Why a send failed when the gateway couldn't be reached or failed mid-turn (decision D3). */
function unreachableError(agentSlug: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  if (agentSlug === BUILTIN_ASSISTANT_SLUG) {
    return `Couldn't reach the assistant stack: ${reason}. Check that it is running, then retry.`;
  }
  const name = getStoredAgent(agentSlug)?.displayName ?? agentSlug;
  return `Couldn't reach ${name} in the assistant stack: ${reason}`;
}

/**
 * True only when Hermes answers that it has no such session; other failures don't count. The
 * agent's profile is passed, since Hermes finds an agent's sessions only in that profile's db.
 */
async function isMissingSession(sessionId: string, agentSlug: string): Promise<boolean> {
  if (localThreads.has(sessionId)) return false;
  try {
    await getHermesGatewaySession().resumeSession(sessionId, {
      historyBudget: DM_HISTORY_BUDGET,
      profile: resolveProfileForAgent(agentSlug),
      omitMessages: true,
    });
    return false;
  } catch (err) {
    return isSessionNotFound(err);
  }
}

function isSessionNotFound(err: unknown): boolean {
  return /not found/i.test(err instanceof Error ? err.message : String(err));
}

/** Carries what Boundary keeps about a session over to the runtime id it resumed as. */
function moveToResumedSession(fromId: string, toId: string, agentSlug: string): void {
  if (durableSessionId(fromId) !== durableSessionId(toId)) dropUnlistedChat(fromId);
  const prev = localThreads.get(fromId);
  if (prev) {
    localThreads.delete(fromId);
    rememberThread({ ...prev, id: toId, agentSlug });
  }
  setSessionAgentSlug(toId, getSessionAgentSlug(fromId) ?? agentSlug);
  migrateSessionInference(fromId, toId);
  // A room keeps its stored id; the runtime id is linked so it still resolves.
  const room = resolveChannel(fromId);
  if (room) {
    setSessionChannelId(toId, room.id);
    const storedId = getHermesGatewaySession().storedSessionId(toId);
    if (storedId !== room.sessionId) moveChannelSession(room, storedId);
  }
  webuiOnlyThreadIds.delete(fromId);
}

/**
 * The live session after a restart, which ends every session Hermes holds. Hermes stores a session
 * on its first prompt, so one that has had no turn can't be resumed and starts again.
 */
async function reviveSession(sessionId: string, agentSlug: string, profile: string | null): Promise<string> {
  const gateway = getHermesGatewaySession();
  await gateway.ensureConnected();
  let revived: string;
  try {
    const resumed = await gateway.resumeSession(gateway.storedSessionId(sessionId), {
      ...resumeOptsFor(sessionId)[0],
      omitMessages: true,
    });
    revived = resumed.sessionId;
  } catch (err) {
    if (resolveChannel(sessionId) || !isSessionNotFound(err)) throw err;
    revived = await gateway.createSessionWithSeed(newSessionOpts(agentSlug, profile, sessionId));
    const projectId = getSessionProjectId(sessionId);
    if (projectId !== undefined) setConversationProjectId([revived], projectId);
    claimNewSession(agentSlug, revived, sessionId);
  }
  if (revived !== sessionId) moveToResumedSession(sessionId, revived, agentSlug);
  return revived;
}

/**
 * The agent's most recent conversation other than `except`: the newest Boundary session in
 * its own profile's db (other sources there, such as board workers, aren't conversations).
 */
async function newestAgentConversation(
  agentSlug: string,
  except: string
): Promise<HermesChatThreadSummary | null> {
  const profile = resolveProfileForAgent(agentSlug);
  if (!profile) return null;
  const listed = await getHermesGatewaySession()
    .listSessions({ profile })
    .catch((): HermesChatThreadSummary[] => []);
  const mine = listed.filter(
    (t) => t.id !== except && (!t.source || t.source === BOUNDARY_SESSION_SOURCE)
  );
  mine.sort(newestFirst);
  return mine[0] ?? null;
}

function finishChannelHistory(
  sessionId: string,
  messages: HermesChatMessage[],
  runtimeId?: string
): HermesChatMessage[] {
  const room = resolveChannel(sessionId) ?? resolveChannel(runtimeId);
  if (room && runtimeId) setSessionChannelId(runtimeId, room.id);
  const roomKey = room?.sessionId;
  const ids = [...new Set([roomKey, sessionId, runtimeId])].filter(
    (id): id is string => Boolean(id)
  );
  const seen = new Set<string>();
  const posts = ids.flatMap((id) => listChannelPosts(id)).filter((post) => {
    if (seen.has(post.id)) return false;
    seen.add(post.id);
    return true;
  });
  const merged = mergeChannelTranscript(posts, messages);
  const speakerKey =
    roomKey && getSessionSpeakers(roomKey).length > 0 ? roomKey : (runtimeId ?? sessionId);
  return annotateMessagesWithSpeakers(speakerKey, merged);
}

function annotateMessagesWithSpeakers(
  sessionId: string,
  messages: HermesChatMessage[]
): HermesChatMessage[] {
  const speakers = getSessionSpeakers(sessionId);
  if (speakers.length === 0) return messages;
  let assistantOrdinal = 0;
  return messages.map((m) => {
    if (m.role !== 'assistant') return m;
    const entry = speakers.find((s) => s.ordinal === assistantOrdinal);
    assistantOrdinal += 1;
    if (!entry) return m;
    return { ...m, agentSlug: entry.agentSlug };
  });
}

export async function getHermesChatHistory(
  sessionId: string
): Promise<HermesChatHistoryResult> {
  if (!sessionId) {
    return { success: true, messages: [] };
  }
  const read = await readHermesChatHistory(sessionId);
  const ids = [sessionId, read.sessionId];
  const result = {
    ...read,
    messages: withFailedTurns(withReplyEndings(read.messages, ids), ids),
  };
  const branch = getSessionBranch(result.sessionId ?? sessionId) ?? getSessionBranch(sessionId);
  return branch ? { ...result, branch } : result;
}

/** Resume options for a session: a DM's history budget (CR 0002 R1), else nothing. */
/**
 * Options for resuming a session: a DM's history budget, and the agent profile that stores it
 * (Hermes looks only in the shared db otherwise, so an agent's session would not be found).
 */
function resumeOptsFor(
  sessionId: string
): [] | [{ historyBudget?: number; profile?: string }] {
  const historyBudget = historyBudgetFor(sessionId);
  const profile = resolveProfileForAgent(getSessionAgentSlug(sessionId));
  if (!historyBudget && !profile) return [];
  return [{ ...(historyBudget ? { historyBudget } : {}), ...(profile ? { profile } : {}) }];
}

async function readHermesChatHistory(sessionId: string): Promise<HermesChatHistoryResult> {
  // A placeholder, or a chat whose only send failed, has no Hermes session until a send works.
  if (dmPlaceholderIds.has(sessionId) || getFailedChat(sessionId)?.local) {
    return { success: true, messages: [], sessionId };
  }
  try {
    const gateway = getHermesGatewaySession();
    // A room is read from its record's session, even if the renderer holds an older id.
    const readId = resolveChannel(sessionId)?.sessionId ?? sessionId;
    let runtimeId = readId;
    try {
      // DMs carry their budget on every resume, so DMs made before it existed get one too.
      const resumed = await gateway.resumeSession(readId, ...resumeOptsFor(readId));
      runtimeId = resumed.sessionId;
      if (resumed.messages.length > 0) {
        return {
          success: true,
          messages: finishChannelHistory(sessionId, resumed.messages, runtimeId),
          sessionId: runtimeId,
        };
      }
    } catch {
      /* fall through to history */
    }

    try {
      const messages = await gateway.getSessionHistory(runtimeId);
      if (messages.length > 0) {
        return {
          success: true,
          messages: finishChannelHistory(sessionId, messages, runtimeId),
          sessionId: runtimeId,
        };
      }
    } catch {
      /* fall through to WebUI */
    }

    const webuiMessages = await getWebuiSessionHistory(sessionId);
    if (webuiMessages.length > 0) {
      webuiOnlyThreadIds.add(sessionId);
      return {
        success: true,
        messages: finishChannelHistory(sessionId, webuiMessages),
        sessionId,
      };
    }

    return {
      success: true,
      messages: finishChannelHistory(sessionId, []),
      sessionId: runtimeId,
    };
  } catch (err) {
    // Gateway and WebUI failures are caught above, so this is a bug in Boundary's own code.
    return {
      success: false,
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getHermesChatContextBreakdown(
  sessionId: string
): Promise<HermesChatBreakdownResult> {
  try {
    const gateway = getHermesGatewaySession();
    const breakdown = await gateway.getContextBreakdown(sessionId);
    return { success: true, breakdown };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function lastUserText(payload: HermesChatStartPayload): string {
  return [...payload.messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '';
}

/**
 * A send failed and Hermes holds nothing for it: keep the message and error in the app's local
 * store, so the chat stays listed and reopens as it looked. Returns the chat's id, a new local
 * one when no session was ever made. Rooms keep their own posts, and a Continue has no message.
 */
async function keepFailedSend(
  payload: HermesChatStartPayload,
  sessionId: string | undefined,
  noReply: HermesNoReply,
  errorCode?: HermesChatStartErrorCode
): Promise<string | undefined> {
  const text = lastUserText(payload);
  if (!text || payload.continue || resolveChannel(sessionId ?? payload.sessionId)) return sessionId;
  try {
    const failure = { noReply, ...(errorCode ? { errorCode } : {}) };
    const retrying = Boolean(payload.retry || payload.rewind);
    if (retrying && sessionId && replaceFailedTurn(sessionId, text, failure)) {
      broadcastSessionsChanged();
      return sessionId;
    }
    if (payload.rewind) {
      // Retry or Edit of a turn Hermes holds: the row stays, and carries the error.
      if (sessionId && payload.rewind.rowId != null) {
        setNoReply(sessionId, payload.rewind.rowId, noReply);
      }
      return sessionId;
    }
    const id = sessionId ?? randomUUID();
    const agentSlug =
      payload.agentSlug?.trim() ||
      (sessionId ? getSessionAgentSlug(sessionId) : null) ||
      BUILTIN_ASSISTANT_SLUG;
    if (!sessionId) {
      setSessionAgentSlug(id, agentSlug);
      setConversationProjectId(
        [id],
        payload.projectId === undefined ? getActiveHermesProjectId() : payload.projectId
      );
      if (payload.inference) await setSessionInferenceOverride({ sessionId: id, ...payload.inference });
    }
    const known = localThreads.get(id)?.title;
    addFailedTurn(
      id,
      {
        title: known && known !== 'New chat' ? known : titleFromMessages(payload.messages),
        agentSlug,
        ...(!sessionId || dmPlaceholderIds.has(id) ? { local: true as const } : {}),
      },
      { text, ...failure, at: new Date().toISOString() }
    );
    broadcastSessionsChanged();
    return id;
  } catch {
    // A store write failed: the send's own error still reaches the screen.
    return sessionId;
  }
}

/** Removes a chat that exists only as Boundary's record of a failed send. */
export function deleteHermesFailedChat(sessionId: string): { success: boolean } {
  deleteFailedChat(sessionId);
  localThreads.delete(sessionId);
  broadcastSessionsChanged();
  return { success: true };
}

/** Starts a turn; a send that fails before it starts is kept (`keepFailedSend`). */
export async function startHermesChatStream(
  sender: WebContents,
  payload: HermesChatStartPayload
): Promise<HermesChatStartResult> {
  const result = await startChatTurn(sender, payload);
  if (result.success || result.errorCode?.startsWith('rewind-')) return withStoredId(result);
  const noReply: HermesNoReply = { reason: 'unreachable', ...(result.error ? { error: result.error } : {}) };
  const sessionId = await keepFailedSend(payload, result.sessionId, noReply, result.errorCode);
  return withStoredId({ ...result, sessionId });
}

/** The screen opens a chat under its runtime id and finds its row by the stored id. */
function withStoredId(result: HermesChatStartResult): HermesChatStartResult {
  return result.sessionId
    ? { ...result, storedSessionId: durableSessionId(result.sessionId) }
    : result;
}

/**
 * Resolves the session, returns immediately with it, then
 * streams in the background.
 */
async function startChatTurn(
  sender: WebContents,
  payload: HermesChatStartPayload
): Promise<HermesChatStartResult> {
  const requestId = payload.requestId ?? randomUUID();
  const key = requestId;
  const toolsEnabled = payload.toolsEnabled !== false;

  const existing = activeStreams.get(key);
  if (existing) {
    existing.controller.abort();
    activeStreams.delete(key);
  }

  const controller = new AbortController();
  const stream = { controller, sessionIds: payload.sessionId ? [payload.sessionId] : [] };
  activeStreams.set(key, stream);

  // Continue sends Boundary's hidden instruction rather than the user's last turn.
  const continuing = payload.continue === true;
  const userText = continuing ? CONTINUE_PROMPT : lastUserText(payload);
  if (!userText) {
    activeStreams.delete(key);
    return { success: false, requestId, error: 'Empty message' };
  }
  if (continuing && (!payload.sessionId || resolveChannel(payload.sessionId))) {
    activeStreams.delete(key);
    return { success: false, requestId, error: CONTINUE_UNSUPPORTED_MESSAGE };
  }

  let sessionId = payload.sessionId;
  const agentSlug =
    payload.agentSlug?.trim() ||
    (sessionId ? getSessionAgentSlug(sessionId) : null) ||
    BUILTIN_ASSISTANT_SLUG;
  const profile = resolveProfileForAgent(agentSlug);
  const channelEarly = resolveChannel(sessionId);
  const channelMembers = channelEarly
    ? listStoredAgents().filter((a) => channelEarly.memberSlugs.includes(a.slug))
    : [];
  const wakeSlugs = channelEarly ? parseMemberMentions(userText, channelMembers) : [];

  // A room post that wakes nobody runs no turn.
  if (channelEarly && sessionId && wakeSlugs.length === 0) {
    appendChannelPost(channelEarly.sessionId, { content: userText, delivery: 'posted' });
    touchChannelUpdatedAt(channelEarly);
    logPostWithoutTurn(requestId, sessionId);
    activeStreams.delete(key);
    return {
      success: true,
      requestId,
      sessionId,
      posted: true,
    };
  }

  try {
    const gateway = getHermesGatewaySession();
    await gateway.ensureConnected();

    if (!sessionId) {
      sessionId = await gateway.createSessionWithSeed(newSessionOpts(agentSlug, profile));
      setSessionAgentSlug(sessionId, agentSlug);
      // An empty composer's first send: the chat starts in the project it was sent from.
      setConversationProjectId(
        [sessionId],
        payload.projectId === undefined ? getActiveHermesProjectId() : payload.projectId
      );
      if (payload.inference) {
        await setSessionInferenceOverride({ sessionId, ...payload.inference });
      }
      rememberThread({
        id: sessionId,
        title: titleFromMessages(payload.messages),
        updatedAt: new Date().toISOString(),
        source: 'boundary',
        agentSlug,
        kind: claimNewSession(agentSlug, sessionId),
      });
    } else if (dmPlaceholderIds.has(sessionId)) {
      const prev = localThreads.get(sessionId);
      const previousId = sessionId;
      dmPlaceholderIds.delete(sessionId);
      localThreads.delete(sessionId);
      sessionId = await gateway.createSessionWithSeed(
        newSessionOpts(agentSlug, profile, previousId)
      );
      setSessionAgentSlug(sessionId, agentSlug);
      migrateSessionInference(previousId, sessionId);
      const kind = claimNewSession(agentSlug, sessionId, previousId);
      rememberThread({
        id: sessionId,
        title:
          prev?.title === 'New chat' || !prev
            ? titleFromMessages(payload.messages)
            : prev.title,
        updatedAt: new Date().toISOString(),
        source: 'boundary',
        agentSlug,
        kind,
      });
    } else {
      // Resume cold / WebUI-origin sessions before the first in-app turn.
      let resumedOk = false;
      let resumeError: unknown = null;
      try {
        // Hermes resumes by stored id and answers "not found" for a runtime id, even a live one.
        // The send needs only the live session, not the transcript resume would return.
        const resumed = await gateway.resumeSession(gateway.storedSessionId(sessionId), {
          ...resumeOptsFor(sessionId)[0],
          omitMessages: true,
        });
        resumedOk = true;
        if (resumed.sessionId !== sessionId) {
          moveToResumedSession(sessionId, resumed.sessionId, agentSlug);
          sessionId = resumed.sessionId;
        }
      } catch (err) {
        /* session may already be live, or WebUI-only */
        resumeError = err;
        const room = resolveChannel(sessionId);
        // A renderer may still hold a room's old id; its record may already be repaired.
        if (room && room.sessionId !== sessionId) {
          try {
            const resumed = await gateway.resumeSession(room.sessionId, { omitMessages: true });
            setSessionChannelId(resumed.sessionId, room.id);
            sessionId = resumed.sessionId;
            resumedOk = true;
          } catch {
            /* fall through */
          }
        }
        if (!resumedOk && room && /not found/i.test(err instanceof Error ? err.message : String(err))) {
          const runtimeId = await gateway.createSessionWithSeed({
            title: `#${room.slug}`,
            profile: null,
          });
          setSessionChannelId(runtimeId, room.id);
          moveChannelSession(room, gateway.storedSessionId(runtimeId));
          sessionId = runtimeId;
          resumedOk = true;
        }
      }

      if (!resumedOk) {
        const prior = await getWebuiSessionHistory(sessionId);
        const isWebuiOnly =
          webuiOnlyThreadIds.has(sessionId) || prior.length > 0;
        if (isWebuiOnly) {
          // Seed a new gateway session from WebUI transcript.
          // Current user turn is submitted via prompt.submit — omit it from seed.
          const prev = localThreads.get(sessionId);
          const title =
            prev?.title && prev.title !== 'New chat'
              ? prev.title
              : titleFromMessages(payload.messages);
          const newId = await gateway.createSessionWithSeed({
            title,
            messages: prior,
            profile,
          });
          webuiOnlyThreadIds.delete(sessionId);
          localThreads.delete(sessionId);
          setSessionAgentSlug(newId, agentSlug);
          migrateSessionInference(sessionId, newId);
          sessionId = newId;
          rememberThread({
            id: sessionId,
            title,
            updatedAt: new Date().toISOString(),
            source: 'boundary',
            agentSlug,
            kind: conversationKindFor(sessionId, agentSlug),
          });
        } else if (
          (agentSlug !== BUILTIN_ASSISTANT_SLUG || getFailedChat(sessionId)) &&
          !resolveChannel(sessionId) &&
          isSessionNotFound(resumeError)
        ) {
          // Hermes has no such session (an empty DM or failed chat it never stored): start a new
          // one in the agent's profile instead of sending into nothing. It takes over as the DM.
          const prev = localThreads.get(sessionId);
          const previousId = sessionId;
          localThreads.delete(previousId);
          dropUnlistedChat(previousId);
          sessionId = await gateway.createSessionWithSeed(
            newSessionOpts(agentSlug, profile, previousId)
          );
          setSessionAgentSlug(sessionId, agentSlug);
          migrateSessionInference(previousId, sessionId);
          const kind = claimNewSession(agentSlug, sessionId, previousId);
          rememberThread({
            id: sessionId,
            title:
              prev?.title && prev.title !== 'New chat'
                ? prev.title
                : titleFromMessages(payload.messages),
            updatedAt: new Date().toISOString(),
            source: 'boundary',
            agentSlug,
            kind,
          });
        } else if (!localThreads.has(sessionId)) {
          // A chat the list already knows keeps its stored agent.
          setSessionAgentSlug(sessionId, agentSlug);
        }
      }
    }

    // The room was found from the id the renderer sent, before any resume swapped it.
    const channel = resolveChannel(sessionId) ?? channelEarly;
    const isChannel = Boolean(channel);

    let truncate: { rowId: number; confirmEmpty: boolean } | undefined;
    if (payload.rewind) {
      const plan = channel
        ? ({
            kind: 'refuse',
            code: 'rewind-unsupported',
            error: 'Edit and Retry are not available in channels yet.',
          } as const)
        : await planRewindForSession(sessionId, payload.rewind);
      if (plan.kind === 'refuse') {
        activeStreams.delete(key);
        return { success: false, requestId, sessionId, errorCode: plan.code, error: plan.error };
      }
      if (plan.kind === 'truncate') {
        truncate = { rowId: plan.rowId, confirmEmpty: plan.confirmEmpty };
      }
    }

    const { blocked, restarted } = await gateResolvedInference(sender, requestId, sessionId);
    if (blocked) {
      activeStreams.delete(key);
      return blocked;
    }
    // Stop can land during the restart above, which runs before the turn exists.
    if (controller.signal.aborted) {
      activeStreams.delete(key);
      sendPhase(sender, { requestId, sessionId, phase: 'done' });
      send(sender, 'hermes-chat:end', { requestId, sessionId, finishReason: 'cancel' });
      return { success: true, requestId, sessionId };
    }
    if (restarted && sessionId) sessionId = await reviveSession(sessionId, agentSlug, profile);

    // A turn runs in its own project's folder.
    await applyConversationFolder(sessionId, [payload.sessionId, channel?.sessionId]);
    const turnSessionIds = [payload.sessionId, sessionId, sessionId ? durableSessionId(sessionId) : null];
    stream.sessionIds = turnSessionIds.filter((id): id is string => Boolean(id));
    const turnStartedAt = Date.now();
    let replied = false;
    beginRunningTurn(requestId, turnSessionIds, isChannel ? null : agentSlug);

    void (async () => {
      try {
        if (isChannel && channel) {
          const roomKey = resolveChannel(sessionId)?.sessionId ?? channel.sessionId;
          const wakePost = appendChannelPost(roomKey, {
            content: userText,
            delivery: 'woke',
          });
          const speakerStart = getSessionSpeakers(roomKey).length;
          await runChannelWakeTurns(
            sender,
            requestId,
            sessionId!,
            userText,
            controller.signal,
            toolsEnabled,
            channel.memberSlugs,
            wakeSlugs,
            roomKey,
            channel.slug
          );
          setChannelPostAssistantCount(
            roomKey,
            wakePost.id,
            Math.max(0, getSessionSpeakers(roomKey).length - speakerStart)
          );
          touchChannelUpdatedAt(channel);
          return;
        }

        const turn = await runJsonRpcTurn(
          sender,
          requestId,
          sessionId!,
          userText,
          controller.signal,
          toolsEnabled,
          {
            profile,
            agentSlug,
            emitEnd: true,
            truncate,
            ...(continuing ? { displayKind: 'hidden' as const } : {}),
            log: {
              kind: conversationKindFor(sessionId!, agentSlug),
              trigger: 'sent',
              agent: agentSlug,
              profile,
              continued: continuing,
              rewind: Boolean(truncate),
            },
          }
        );
        replied = !turn.noReply;
        // Stop and Send now are noted once Hermes confirms the stop (settleInterruptedTurn).
        if (turn.noReply && !controller.signal.aborted) {
          const held = await recordNoReply(sessionId!, turn.noReply, turnStartedAt).catch(() => false);
          if (!held) await keepFailedSend(payload, sessionId, turn.noReply);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // A refused rewind has its own message; a room's or Continue's error is Hermes's own.
        const error = payload.rewind
          ? describeRewindError(err)
          : isChannel || continuing
            ? err instanceof Error
              ? err.message
              : String(err)
            : unreachableError(agentSlug, err);
        await keepFailedSend(payload, sessionId, { reason: 'unreachable', error });
        send(sender, 'hermes-chat:error', { requestId, error });
      } finally {
        activeStreams.delete(key);
        endRunningTurn(requestId);
        if (sessionId) noteFallbackServed(sessionId, turnStartedAt, replied);
      }
    })();

    return { success: true, requestId, sessionId };
  } catch (err) {
    activeStreams.delete(key);
    return {
      success: false,
      requestId,
      sessionId,
      errorCode: 'gateway-unreachable',
      error: channelEarly
        ? 'Channel wake needs the local assistant stack.'
        : unreachableError(agentSlug, err),
    };
  }
}

/** Stop a turn by its request id, or every turn of a chat when `sessionId` is given. */
export function handleHermesChatCancel(payload: HermesChatCancelPayload): { success: boolean } {
  for (const [key, stream] of activeStreams) {
    const sessionId = payload.sessionId;
    if (key !== payload.requestId && !(sessionId && stream.sessionIds.includes(sessionId))) continue;
    // The reason rides on the signal so the turn can note how its reply ended.
    stream.controller.abort(payload.reason ?? 'stopped');
    activeStreams.delete(key);
  }
  return { success: true };
}
