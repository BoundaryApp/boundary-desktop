import { createHash, randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import type {
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
  HermesChatToolEvent,
  HermesChatTransport,
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
import { startHermesHttpChatStream } from './hermesHttpChat';
import { extractPathsFromToolArgs } from './hermesToolPaths';
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
  copySessionInference,
  getSessionBranch,
  setSessionBranch,
  setChannelPostAssistantCount,
  setSessionAgentSlug,
  setSessionChannelId,
  getStandingDmSessionId,
  setStandingDmSessionId,
  getStoredSessionAlias,
  setStoredSessionAlias,
  getOrchestratorRecord,
  getRoomSoulSent,
  setRoomSoulSent,
  upsertStoredChannel,
} from './hermesAgentStore';
import {
  buildChannelHeader,
  buildChannelWakePrompt,
  buildMemberSoulContext,
  buildOrchestratorRoomNote,
  channelForSession,
  mergeChannelTranscript,
  moveChannelSession,
  parseMemberMentions,
  reconcileChannelSessions,
} from './hermesChannels';
import { inferenceSlotLabel } from '../../../../shared/inferenceDisplay';
import { ensureResolvedInferenceReady } from './sessionInference';
import { lagLog, roundMs } from '../../../perf/lagLog';
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
  withReplyEndings,
} from './hermesReplyEndings';

function streamKey(webContentsId: number, requestId: string): string {
  return `${webContentsId}:${requestId}`;
}

const activeStreams = new Map<string, AbortController>();

const CONTINUE_UNSUPPORTED_MESSAGE =
  'Continue needs the local assistant stack, and is not available in channels.';
const localThreads = new Map<string, HermesChatThreadSummary>();
/** Thread ids minted only for HTTP fallback — remint on JSON-RPC connect. */
const httpFallbackThreadIds = new Set<string>();
/** Session ids that exist only in WebUI JSON (not in gateway state.db). */
const webuiOnlyThreadIds = new Set<string>();
/**
 * Chats made here that Hermes doesn't list yet: session.list leaves out a session with no
 * messages. Without this a new, empty chat drops out of the list on the next refresh, and
 * its composer chip can't file it (ADR 0024 §5). Dropped once Hermes lists the chat.
 */
const unlistedNewChats = new Map<string, HermesChatThreadSummary>();

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

/** Last renderer that started a chat — used to deliver approval prompts. */
let lastChatSender: WebContents | null = null;

function send(sender: WebContents, channel: string, data: unknown): void {
  if (!sender.isDestroyed()) {
    sender.send(channel, data);
  }
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
): Promise<HermesChatStartResult | null> {
  const ready = await ensureResolvedInferenceReady(sessionId, (resolved) => {
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'restarting',
      toolName: inferenceSlotLabel(resolved.slot),
    });
  });
  if (ready.ok === true) return null;
  return {
    success: false,
    requestId,
    sessionId,
    error: ready.error,
    errorCode: ready.errorCode,
  };
}

function wireApprovalNotifier(): void {
  const gateway = getHermesGatewaySession();
  gateway.setStoredIdArchive({ get: getStoredSessionAlias, set: setStoredSessionAlias });
  gateway.setApprovalNotifier((event) => {
    if (lastChatSender && !lastChatSender.isDestroyed()) {
      send(lastChatSender, 'hermes-chat:approval', event);
    }
  });
  gateway.setCredentialRequestNotifier((event) => {
    if (!lastChatSender || lastChatSender.isDestroyed()) return false;
    send(lastChatSender, 'hermes-chat:credential-request', event);
    return true;
  });
}

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
     * Turn context for the model (a room's header). Sent as `prompt.submit`'s `context` when
     * the gateway takes it, otherwise put above the message text.
     */
    context?: string;
  }
): Promise<{ assistantText: string; noReply?: HermesNoReply }> {
  const gateway = getHermesGatewaySession();
  await gateway.ensureConnected();
  wireApprovalNotifier();
  // A turn stopped just before this one may still be winding down on Hermes; a submit
  // now would land on a busy session and be redirected or queued instead of run.
  await sessionSettled(sessionId);

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
  const emitEnd = opts?.emitEnd !== false;
  const profile = opts?.profile ?? null;
  const agentSlug = opts?.agentSlug ?? null;

  try {
    maxTurns = await gateway.getMaxTurns();
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

  const markFirstEvent = () => {
    if (firstEventAt == null) firstEventAt = Date.now();
  };

  const endOnce = (finishReason?: string, complete?: MessageCompletePayload) => {
    if (ended) return;
    ended = true;
    if (visibleTokens === 0) {
      noReply = noReplyFor(finishReason, complete, signal);
    }
    const ttftSec =
      firstEventAt != null ? (firstEventAt - startedAt) / 1000 : null;
    sendTurnStats(sender, {
      requestId,
      sessionId,
      prompt: latestUsage?.prompt ?? latestUsage?.input ?? null,
      generated: latestUsage?.completion ?? latestUsage?.output ?? null,
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
    if (keep) armQuiet();
    else endOnce('timeout');
  };
  const armQuiet = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = ended ? null : setTimeout(() => void checkQuiet(), quietMs);
  };

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
      phase: visibleTokens > 0 ? 'generating' : 'preparing',
      visibleTokens,
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage,
    });
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
    if (ended || signal.aborted || visibleTokens > 0) return;
    sendPhase(sender, {
      requestId,
      sessionId,
      phase: 'preparing',
      elapsedSec: Math.floor((Date.now() - startedAt) / 1000),
      maxTurns: maxTurns ?? undefined,
      usage: latestUsage,
    });
  }, 1000);

  armQuiet();

  try {
    const submitOpts = {
      truncate: opts?.truncate,
      ...(opts?.displayKind ? { displayKind: opts.displayKind } : {}),
    };
    const context = opts?.context;
    if (context && (await gateway.supportsClientContext())) {
      try {
        await gateway.submitPrompt(sessionId, userText, { ...submitOpts, context });
      } catch (err) {
        // 4082: a turn is still running, and context can't be queued. Send it inline instead.
        if ((err as { code?: unknown })?.code !== CONTEXT_TURN_RUNNING) throw err;
        await gateway.submitPrompt(sessionId, `${context}\n\n${userText}`, submitOpts);
      }
    } else {
      await gateway.submitPrompt(
        sessionId,
        context ? `${context}\n\n${userText}` : userText,
        submitOpts
      );
    }
    if (!ended && !signal.aborted) {
      await turnDone;
    }
  } finally {
    if (quietTimer) clearTimeout(quietTimer);
    clearInterval(preparingTicker);
    signal.removeEventListener('abort', onAbort);
    unsubDelta();
    unsubComplete();
    unsubUsage();
    unsubHeartbeat();
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
    timing.webuiMs = roundMs(performance.now() - started);
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
        ms: roundMs(performance.now() - started),
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
  const since = (from: number) => roundMs(performance.now() - from);
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

    // If both fail to produce anything and gateway threw, keep local fallback below.
    // When gateway.listSessions succeeds (even empty), merge with WebUI.
    const merged = performance.now();
    const sessions = withUnlistedNewChats(
      mergeHermesThreadLists(gatewaySessions, webuiSessions),
      (id) => gateway.storedSessionId(id)
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
    // Last resort: still try WebUI-only list.
    try {
      const webuiSessions = (await fetchWebuiList()) ?? webuiCache?.list ?? [];
      webuiOnlyThreadIds.clear();
      for (const t of webuiSessions) webuiOnlyThreadIds.add(t.id);
      if (webuiSessions.length > 0) {
        localThreads.clear();
        for (const s of webuiSessions) rememberThread(s);
        return { success: true, threads: fileThreads(annotateThreadsWithAgents(webuiSessions)) };
      }
    } catch {
      /* ignore */
    }
    return {
      success: true,
      threads: fileThreads(annotateThreadsWithAgents(Array.from(localThreads.values()))),
      error: err instanceof Error ? err.message : String(err),
    };
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
  } catch {
    const thread: HermesChatThreadSummary = {
      id: randomUUID(),
      title: 'New chat',
      updatedAt: new Date().toISOString(),
      agentSlug,
      kind: 'hermes',
      projectId,
    };
    httpFallbackThreadIds.add(thread.id);
    setSessionAgentSlug(thread.id, agentSlug);
    setConversationProjectId([thread.id], projectId);
    rememberThread(thread);
    return { success: true, thread };
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
  const placeholder = standing ? httpFallbackThreadIds.has(standing) : false;
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
  httpFallbackThreadIds.add(id);
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

/**
 * Why an agent's turn didn't send. The HTTP fallback is the default assistant with none of the
 * agent's role or tools, so an agent's turn fails visibly instead.
 */
function agentUnreachable(agentSlug: string, err: unknown): string {
  const name = getStoredAgent(agentSlug)?.displayName ?? agentSlug;
  const reason = err instanceof Error ? err.message : String(err);
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
    });
    return false;
  } catch (err) {
    return isSessionNotFound(err);
  }
}

function isSessionNotFound(err: unknown): boolean {
  return /not found/i.test(err instanceof Error ? err.message : String(err));
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
  mine.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
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
  const result = {
    ...read,
    messages: withReplyEndings(read.messages, [sessionId, read.sessionId]),
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
  // A placeholder has no Hermes session until its first send.
  if (httpFallbackThreadIds.has(sessionId)) return { success: true, messages: [], sessionId };
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
    try {
      const webuiMessages = await getWebuiSessionHistory(sessionId);
      if (webuiMessages.length > 0) {
        webuiOnlyThreadIds.add(sessionId);
        return {
          success: true,
          messages: finishChannelHistory(sessionId, webuiMessages),
          sessionId,
        };
      }
    } catch {
      /* ignore */
    }
    const overlay = finishChannelHistory(sessionId, []);
    if (overlay.length > 0) {
      return { success: true, messages: overlay, sessionId };
    }
    return {
      success: false,
      messages: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getHermesChatContextBreakdown(
  sessionId: string
): Promise<{ success: boolean; breakdown?: unknown; error?: string }> {
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

/**
 * Resolves session + transport, returns immediately with those fields, then
 * streams in the background.
 */
export async function startHermesChatStream(
  sender: WebContents,
  payload: HermesChatStartPayload
): Promise<HermesChatStartResult> {
  const requestId = payload.requestId ?? randomUUID();
  const key = streamKey(sender.id, requestId);
  const toolsEnabled = payload.toolsEnabled !== false;

  lastChatSender = sender;
  wireApprovalNotifier();

  const existing = activeStreams.get(key);
  if (existing) {
    existing.abort();
    activeStreams.delete(key);
  }

  const controller = new AbortController();
  activeStreams.set(key, controller);

  // Continue sends Boundary's hidden instruction rather than the user's last turn.
  const continuing = payload.continue === true;
  const userText = continuing
    ? CONTINUE_PROMPT
    : ([...payload.messages].reverse().find((m) => m.role === 'user')?.content?.trim() ?? '');
  if (!userText) {
    activeStreams.delete(key);
    return { success: false, requestId, error: 'Empty message' };
  }
  if (continuing && (!payload.sessionId || resolveChannel(payload.sessionId))) {
    activeStreams.delete(key);
    return { success: false, requestId, error: CONTINUE_UNSUPPORTED_MESSAGE };
  }

  let sessionId = payload.sessionId;
  let transport: HermesChatTransport = 'http';
  const agentSlug =
    payload.agentSlug?.trim() ||
    (sessionId ? getSessionAgentSlug(sessionId) : null) ||
    BUILTIN_ASSISTANT_SLUG;
  const profile = resolveProfileForAgent(agentSlug);
  const channelEarly = resolveChannel(sessionId);
  const channelMembers = channelEarly
    ? listStoredAgents().filter((a) => channelEarly.memberSlugs.includes(a.slug))
    : [];
  const wakeSlugsEarly = channelEarly
    ? parseMemberMentions(userText, channelMembers)
    : [];

  if (channelEarly && sessionId && wakeSlugsEarly.length === 0) {
    appendChannelPost(channelEarly.sessionId, { content: userText, delivery: 'posted' });
    touchChannelUpdatedAt(channelEarly);
    if (localThreads.has(sessionId)) {
      const prev = localThreads.get(sessionId)!;
      rememberThread({
        ...prev,
        title:
          prev.title === 'New chat' || !prev.title
            ? titleFromMessages(payload.messages)
            : prev.title,
        updatedAt: new Date().toISOString(),
      });
    }
    activeStreams.delete(key);
    return {
      success: true,
      requestId,
      sessionId,
      transport: 'json-rpc',
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
      rememberThread({
        id: sessionId,
        title: titleFromMessages(payload.messages),
        updatedAt: new Date().toISOString(),
        source: 'boundary',
        agentSlug,
        kind: claimNewSession(agentSlug, sessionId),
      });
    } else if (httpFallbackThreadIds.has(sessionId)) {
      const prev = localThreads.get(sessionId);
      const previousId = sessionId;
      httpFallbackThreadIds.delete(sessionId);
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
        const resumed = await gateway.resumeSession(sessionId, ...resumeOptsFor(sessionId));
        resumedOk = true;
          if (resumed.sessionId !== sessionId) {
          const prev = localThreads.get(sessionId);
          if (prev) {
            localThreads.delete(sessionId);
            rememberThread({ ...prev, id: resumed.sessionId, agentSlug });
          }
          const priorSlug = getSessionAgentSlug(sessionId) ?? agentSlug;
          setSessionAgentSlug(resumed.sessionId, priorSlug);
          migrateSessionInference(sessionId, resumed.sessionId);
          // A room keeps its stored id; the runtime id is linked so it still resolves.
          const room = resolveChannel(sessionId);
          if (room) {
            setSessionChannelId(resumed.sessionId, room.id);
            const storedId = gateway.storedSessionId(resumed.sessionId);
            if (storedId !== room.sessionId) moveChannelSession(room, storedId);
          }
          webuiOnlyThreadIds.delete(sessionId);
          sessionId = resumed.sessionId;
        }
      } catch (err) {
        /* session may already be live, or WebUI-only */
        resumeError = err;
        const room = resolveChannel(sessionId);
        // A renderer may still hold a room's old id; its record may already be repaired.
        if (room && room.sessionId !== sessionId) {
          try {
            const resumed = await gateway.resumeSession(room.sessionId);
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
          agentSlug !== BUILTIN_ASSISTANT_SLUG &&
          !resolveChannel(sessionId) &&
          isSessionNotFound(resumeError)
        ) {
          // Hermes has no such session (an empty DM it never stored): start a new one in the
          // agent's profile instead of sending into nothing, and let it take over as the DM.
          const prev = localThreads.get(sessionId);
          const previousId = sessionId;
          localThreads.delete(previousId);
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
        } else if (localThreads.has(sessionId)) {
          const prev = localThreads.get(sessionId)!;
          rememberThread({
            ...prev,
            agentSlug: prev.agentSlug ?? agentSlug,
            title:
              prev.title === 'New chat'
                ? titleFromMessages(payload.messages)
                : prev.title,
            updatedAt: new Date().toISOString(),
          });
        } else {
          setSessionAgentSlug(sessionId, agentSlug);
          rememberThread({
            id: sessionId,
            title: titleFromMessages(payload.messages),
            updatedAt: new Date().toISOString(),
            agentSlug,
            kind: conversationKindFor(sessionId, agentSlug),
          });
        }
      } else if (localThreads.has(sessionId)) {
        const prev = localThreads.get(sessionId)!;
        rememberThread({
          ...prev,
          title:
            prev.title === 'New chat' ? titleFromMessages(payload.messages) : prev.title,
          updatedAt: new Date().toISOString(),
        });
      } else {
        rememberThread({
          id: sessionId,
          title: titleFromMessages(payload.messages),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    transport = 'json-rpc';

    // The room was found from the id the renderer sent, before any resume swapped it.
    const channel = resolveChannel(sessionId) ?? channelEarly;
    const isChannel = Boolean(channel);
    const channelMembers = channel
      ? listStoredAgents().filter((a) => channel.memberSlugs.includes(a.slug))
      : [];
    const wakeSlugs = channel ? parseMemberMentions(userText, channelMembers) : [];
    const postOnly = Boolean(channel) && wakeSlugs.length === 0;

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

    if (!postOnly) {
      const blocked = await gateResolvedInference(sender, requestId, sessionId);
      if (blocked) {
        activeStreams.delete(key);
        return blocked;
      }
    }

    // A room post that wakes nobody runs no turn. A turn runs in its own project's folder.
    if (!postOnly) {
      await applyConversationFolder(sessionId, [payload.sessionId, channel?.sessionId]);
      beginRunningTurn(
        requestId,
        [payload.sessionId, sessionId, sessionId ? durableSessionId(sessionId) : null],
        isChannel ? null : agentSlug
      );
    }

    void (async () => {
      try {
        if (isChannel && channel) {
          const members = listStoredAgents().filter((a) =>
            channel.memberSlugs.includes(a.slug)
          );
          const wakeSlugs = parseMemberMentions(userText, members);
          const roomKey = resolveChannel(sessionId)?.sessionId ?? channel.sessionId;
          if (wakeSlugs.length === 0) {
            appendChannelPost(roomKey, { content: userText, delivery: 'posted' });
            touchChannelUpdatedAt(channel);
            send(sender, 'hermes-chat:end', {
              requestId,
              sessionId,
              finishReason: 'stop',
            });
            return;
          }
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
          }
        );
        // Stop and Send now are noted once Hermes confirms the stop (settleInterruptedTurn).
        if (turn.noReply && !controller.signal.aborted) {
          await recordNoReply(sessionId!, turn.noReply).catch((): void => undefined);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        // A refused rewind must not fall back to an HTTP turn that Hermes never sees.
        if (payload.rewind) {
          send(sender, 'hermes-chat:error', { requestId, error: describeRewindError(err) });
          return;
        }
        // Continue only means something to Hermes, which holds the partial.
        if (continuing) {
          send(sender, 'hermes-chat:error', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // Channel wake has no HTTP multi-profile fallback.
        if (isChannel) {
          send(sender, 'hermes-chat:error', {
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        // The HTTP API runs as the default assistant: an agent's turn must not land there.
        if (agentSlug !== BUILTIN_ASSISTANT_SLUG) {
          send(sender, 'hermes-chat:error', { requestId, error: agentUnreachable(agentSlug, err) });
          return;
        }
        try {
          await startHermesHttpChatStream(payload.messages, controller.signal, {
            onDelta: (delta) => send(sender, 'hermes-chat:chunk', { requestId, delta }),
            onEnd: (finishReason) =>
              send(sender, 'hermes-chat:end', { requestId, sessionId, finishReason }),
            onError: (error) => send(sender, 'hermes-chat:error', { requestId, error }),
          });
        } catch (httpErr) {
          send(sender, 'hermes-chat:error', {
            requestId,
            error:
              httpErr instanceof Error
                ? httpErr.message
                : err instanceof Error
                  ? err.message
                  : String(err),
          });
        }
      } finally {
        activeStreams.delete(key);
        endRunningTurn(requestId);
      }
    })();

    return { success: true, requestId, sessionId, transport };
  } catch (err) {
    if (channelEarly) {
      activeStreams.delete(key);
      return {
        success: false,
        requestId,
        sessionId,
        error: 'Channel wake needs the local assistant stack.',
      };
    }
    if (agentSlug !== BUILTIN_ASSISTANT_SLUG) {
      activeStreams.delete(key);
      return { success: false, requestId, sessionId, error: agentUnreachable(agentSlug, err) };
    }
    /* fall through to HTTP */
  }

  if (payload.rewind) {
    activeStreams.delete(key);
    return {
      success: false,
      requestId,
      sessionId,
      errorCode: 'rewind-unsupported',
      error: 'Edit and Retry need the local assistant stack to be running.',
    };
  }

  if (continuing) {
    activeStreams.delete(key);
    return { success: false, requestId, sessionId, error: CONTINUE_UNSUPPORTED_MESSAGE };
  }

  if (!sessionId) {
    sessionId = randomUUID();
    httpFallbackThreadIds.add(sessionId);
    rememberThread({
      id: sessionId,
      title: titleFromMessages(payload.messages),
      updatedAt: new Date().toISOString(),
    });
  } else if (localThreads.has(sessionId)) {
    const prev = localThreads.get(sessionId)!;
    rememberThread({
      ...prev,
      title:
        prev.title === 'New chat' ? titleFromMessages(payload.messages) : prev.title,
      updatedAt: new Date().toISOString(),
    });
  }

  transport = 'http';

  const blocked = await gateResolvedInference(sender, requestId, sessionId);
  if (blocked) {
    activeStreams.delete(key);
    return blocked;
  }

  void (async () => {
    try {
      sendPhase(sender, {
        requestId,
        sessionId,
        phase: 'preparing',
        elapsedSec: 0,
      });
      await startHermesHttpChatStream(payload.messages, controller.signal, {
        onDelta: (delta) => {
          send(sender, 'hermes-chat:chunk', { requestId, delta });
          sendPhase(sender, {
            requestId,
            sessionId,
            phase: 'generating',
          });
        },
        onEnd: (finishReason) => {
          sendPhase(sender, { requestId, sessionId, phase: 'done' });
          send(sender, 'hermes-chat:end', { requestId, sessionId, finishReason });
        },
        onError: (error) => send(sender, 'hermes-chat:error', { requestId, error }),
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      send(sender, 'hermes-chat:error', {
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      activeStreams.delete(key);
    }
  })();

  return { success: true, requestId, sessionId, transport };
}

export function handleHermesChatCancel(
  webContentsId: number,
  payload: HermesChatCancelPayload
): { success: boolean } {
  const key = streamKey(webContentsId, payload.requestId);
  const controller = activeStreams.get(key);
  if (controller) {
    // The reason rides on the signal so the turn can note how its reply ended.
    controller.abort(payload.reason ?? 'stopped');
    activeStreams.delete(key);
  }
  return { success: true };
}

export function cancelAllHermesChatStreamsForWebContents(webContentsId: number): void {
  const prefix = `${webContentsId}:`;
  for (const [key, controller] of activeStreams) {
    if (key.startsWith(prefix)) {
      controller.abort();
      activeStreams.delete(key);
    }
  }
}
