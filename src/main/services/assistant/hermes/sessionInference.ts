import { randomUUID } from 'node:crypto';
import { inferenceSlotLabel, isVisibleChatProvider } from '../../../../shared/inferenceDisplay';
import {
  meetsLevel,
  projectConfidentialFloor,
  type TrustLevel,
} from '../../../../shared/types/confidential';
import type { InferenceChainEntry, InferenceChainEntryState } from '../../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../../shared/types/onboarding';
import type {
  HermesChatStartErrorCode,
  HermesSessionInferenceResult,
  HermesSessionInferenceSetPayload,
  ResolvedSessionInference,
  TurnWindow,
} from '../../../../shared/types/hermesChat';
import { probeSlotHealth } from '../../onboarding/probeSlotHealth';
import { getSlotLlmConnection } from '../../onboarding/OpenAiOnboardingStore';
import { keepChainFallbacks } from '../../inference/appInferenceChoice';
import { applyLlmConnectionToHermes, settleHermesApply } from '../AssistantStackService';
import { getLastAppliedLlm, llmFingerprintsMatch } from '../AssistantStackStore';
import { sharedModelFacts, sharedProviderNames } from '../../circles/circlesService';
import {
  chainPoolSettings,
  chainPoolsEnabled,
  planInferenceChain,
  poolConnection,
  poolProviderLabel,
  sharedModelConnection,
} from '../../inference/inferenceChainService';
import { isLocalAssistantStackMode } from '../localStackMode';
import {
  inferenceRouterPushed,
  latestInferenceRouterServed,
  setInferenceRouterChain,
  takeInferenceRouterPoolTurn,
  type RouterPoolTurn,
} from '../../inference/inferenceRouterService';
import type { RouterChain, RouterServed } from '../../inference/router/chainRouter';
import {
  appendPoolServedTurn,
  appendSessionInferenceMark,
  appendSessionTurnWindow,
  clearSessionInference,
  closeSessionTurnWindow,
  getSessionInference,
  listPoolServedTurns,
  listSessionInferenceMarks,
  listSessionTurnWindows,
  setSessionInference,
  type StoredTurnWindow,
} from './hermesAgentStore';
import { resolveSessionInference, sessionPrivacyLocked, sessionProjectPin } from './resolveSessionInference';
import { listRunningTurns, notePoolFloorSent, poolFloorSent } from './hermesRunningTurns';

/**
 * The lowest provider level a private chat's pools may use: its project's, from Pool settings and
 * Allow level B. Undefined for a chat that isn't private, or while pools are off.
 */
function sessionPoolFloor(sessionId: string | null | undefined, privacyLocked: boolean): TrustLevel | undefined {
  const settings = privacyLocked ? chainPoolSettings() : null;
  return settings ? projectConfidentialFloor(sessionProjectPin(sessionId), settings) : undefined;
}

/** The level's whole chain, cut by the lock: the one answer the send and the chip both use. */
async function planResolved(
  resolved: ResolvedSessionInference,
  privacyLocked: boolean,
  projectFloor: TrustLevel | undefined
) {
  // The level that supplied the model supplies the whole chain (ADR 0033 §1).
  const fallbacks = resolved.fallbacks ?? [];
  // A pool or a shared model is reached only through the router, so it is always planned.
  return fallbacks.length || privacyLocked || resolved.slot === 'peer' || resolved.slot === 'confidential'
    ? planInferenceChain(
        { slot: resolved.slot, modelId: resolved.modelId, ...(resolved.peer ? { peer: resolved.peer } : {}) },
        fallbacks,
        { privacyLocked, ...(projectFloor ? { projectFloor } : {}) }
      )
    : ({ kind: 'direct' } as const);
}

/** What the chat's UI shows: the resolved inference and whether the privacy lock stops a send. */
async function resolveForChat(sessionId: string | null): Promise<ResolvedSessionInference | null> {
  const resolved = await resolveSessionInference(sessionId);
  if (!resolved || !sessionPrivacyLocked(sessionId)) return resolved;
  const projectFloor = sessionPoolFloor(sessionId, true);
  const plan = resolved.configured ? await planResolved(resolved, true, projectFloor) : null;
  const refused = plan?.kind === 'refused' && plan.privacy === true ? plan : null;
  return {
    ...resolved,
    privacyLocked: true,
    privacyRefused: refused !== null,
    ...(projectFloor ? { projectFloor } : {}),
    ...(refused?.poolStop ? { poolStop: refused.poolStop } : {}),
  };
}

/**
 * Whether the chain may send a request somewhere a private project's request can't go, when that
 * project's pools reach no lower than `floor`. A pool counts as private only when it was planned
 * for a privacy-locked chat at `floor` or higher: only then does its upstream keep every level
 * below `floor` out. With pools off (`floor` undefined) a pool entry can't serve anyway.
 */
function reachesBelow(chain: RouterChain, floor: TrustLevel | undefined): boolean {
  return chain.entries.some((state) => {
    if (!state.private) return true;
    if (state.entry.slot !== 'confidential') return false;
    const pool = chain.upstreams[state.key]?.pool;
    if (pool?.privateProject !== true) return true;
    return Boolean(floor && !(pool.projectFloor && meetsLevel(pool.projectFloor, floor)));
  });
}

/** The higher of two levels. */
function stricter(a: TrustLevel, b: TrustLevel): TrustLevel {
  return meetsLevel(a, b) ? a : b;
}

/**
 * Whether a private turn is running, and the highest pool floor among them. A private turn's next
 * request goes to the router's current chain, so it can't take a wider one. Its floor is the one
 * its send was planned at, or its project's now when that is higher (Allow level B undone).
 */
function runningPrivateTurns(): { running: boolean; floor?: TrustLevel } {
  let running = false;
  let floor: TrustLevel | undefined;
  for (const turn of listRunningTurns()) {
    for (const id of turn.sessionIds) {
      if (!sessionPrivacyLocked(id)) continue;
      running = true;
      for (const level of [poolFloorSent(id), sessionPoolFloor(id, true)]) {
        if (level) floor = floor ? stricter(floor, level) : level;
      }
    }
  }
  return { running, ...(floor ? { floor } : {}) };
}

export async function getSessionInferenceSnapshot(
  sessionId: string
): Promise<HermesSessionInferenceResult> {
  if (!sessionId.trim()) {
    return {
      success: false,
      override: null,
      resolved: await resolveForChat(null),
      marks: [],
      poolTurns: [],
      turnWindows: [],
      error: 'Missing session.',
    };
  }
  return {
    success: true,
    override: getSessionInference(sessionId),
    resolved: await resolveForChat(sessionId),
    marks: listSessionInferenceMarks(sessionId),
    poolTurns: listPoolServedTurns(sessionId),
    turnWindows: listTurnWindows(sessionId),
  };
}

export async function setSessionInferenceOverride(
  payload: HermesSessionInferenceSetPayload
): Promise<HermesSessionInferenceResult> {
  const sessionId = payload.sessionId?.trim();
  if (!sessionId) {
    return {
      success: false,
      override: null,
      resolved: null,
      marks: [],
      poolTurns: [],
      turnWindows: [],
      error: 'Missing session.',
    };
  }
  // A chain may keep a cloud fallback, which the lock cuts; a chat can't start on one (ADR 0033 §4).
  if (payload.provider !== 'local' && sessionPrivacyLocked(sessionId)) {
    return {
      success: false,
      override: getSessionInference(sessionId),
      resolved: await resolveForChat(sessionId),
      marks: listSessionInferenceMarks(sessionId),
      poolTurns: listPoolServedTurns(sessionId),
      turnWindows: listTurnWindows(sessionId),
      error: 'This project is private, so its chats can’t use a cloud model.',
    };
  }
  const connection = await getSlotLlmConnection(payload.provider);
  if (!connection) {
    return {
      success: false,
      override: getSessionInference(sessionId),
      resolved: await resolveForChat(sessionId),
      marks: listSessionInferenceMarks(sessionId),
      poolTurns: listPoolServedTurns(sessionId),
      turnWindows: listTurnWindows(sessionId),
      error: 'That provider is not connected.',
    };
  }
  const modelId = payload.modelId.trim() || connection.modelId;
  const prior = getSessionInference(sessionId);
  // What the chat used before, inherited or not: turning on a fallback for the model it already
  // uses is not a switch.
  const before = await resolveSessionInference(sessionId);
  const kept = await keepChainFallbacks(
    { slot: payload.provider, modelId },
    payload.fallbacks ?? prior?.fallbacks ?? []
  );
  if (kept.ok === false) {
    return {
      success: false,
      override: prior,
      resolved: await resolveForChat(sessionId),
      marks: listSessionInferenceMarks(sessionId),
      poolTurns: listPoolServedTurns(sessionId),
      turnWindows: listTurnWindows(sessionId),
      error: kept.error,
    };
  }
  setSessionInference(sessionId, { provider: payload.provider, modelId, fallbacks: kept.fallbacks });
  if (before?.slot !== payload.provider || before.modelId !== modelId) {
    appendSessionInferenceMark(sessionId, {
      kind: 'switched',
      provider: payload.provider,
      modelId,
    });
  }
  return getSessionInferenceSnapshot(sessionId);
}

export async function clearSessionInferenceOverride(
  sessionId: string
): Promise<HermesSessionInferenceResult> {
  const id = sessionId.trim();
  if (!id) {
    return {
      success: false,
      override: null,
      resolved: await resolveForChat(null),
      marks: [],
      poolTurns: [],
      turnWindows: [],
      error: 'Missing session.',
    };
  }
  clearSessionInference(id);
  return getSessionInferenceSnapshot(id);
}

/** Told before an apply (`restarting` false), and again only if Hermes really restarts for it. */
type InferenceApplyListener = (
  resolved: ResolvedSessionInference,
  sharedUnavailable: boolean,
  restarting: boolean
) => void;

type InferenceReady =
  | { ok: true; resolved: ResolvedSessionInference }
  | { ok: false; error: string; errorCode?: HermesChatStartErrorCode; sharedUnavailable?: boolean; provider?: string };

function slotAnswerName(slot: InferenceSlotId): string {
  return slot === 'local' ? 'your local model' : inferenceSlotLabel(slot);
}

/** A failed probe only shows the service didn't answer, so the words stop there. */
function unanswered(names: string[], sharedUnavailable: boolean): InferenceReady {
  const who = names.join(' and ');
  return {
    ok: false,
    error: sharedUnavailable
      ? `Your shared model isn’t available and ${who} didn’t answer, so your message wasn’t sent.`
      : `${who.charAt(0).toUpperCase()}${who.slice(1)} didn’t answer, so your message wasn’t sent.`,
    errorCode: 'provider-unreachable',
    ...(sharedUnavailable ? { sharedUnavailable } : {}),
  };
}

async function slotAnswers(slot: InferenceSlotId): Promise<boolean> {
  return (await probeSlotHealth(slot)).health !== 'unreachable';
}

/**
 * The chain's slots when none of them answers and no online member or pool can serve; otherwise
 * null. A pool isn't probed: the router moves between its providers before the first byte.
 */
async function silentChainSlots(entries: InferenceChainEntryState[]): Promise<string[] | null> {
  const usable = entries.filter((state) => !state.stale).map((state) => state.entry.slot);
  if (usable.includes('peer') || usable.includes('confidential')) return null;
  const names: string[] = [];
  for (const slot of new Set(usable as InferenceSlotId[])) {
    if (await slotAnswers(slot)) return null;
    names.push(slotAnswerName(slot));
  }
  return names.length ? names : null;
}

/**
 * Whether a send must probe though it needs no apply: the rest of the chain has to answer now.
 * With this and an apply as the only triggers, an ordinary send adds no network call. Nothing is
 * cached: a probe is cheap next to an apply, and a Retry has to ask afresh.
 */
function sharedProviderOffline(entries: InferenceChainEntry[]): boolean {
  const peers = entries.flatMap((entry) => (entry.slot === 'peer' && entry.peer ? [entry.peer] : []));
  return peers.length > 0 && peers.some((peer) => !sharedModelFacts().providerOnline(peer));
}

export async function ensureResolvedInferenceReady(
  sessionId: string | undefined,
  onApply?: InferenceApplyListener
): Promise<InferenceReady> {
  const planned: { floor?: TrustLevel } = {};
  const ready = await resolvedInferenceReady(sessionId, onApply, planned);
  // Only a send that goes ahead sets the floor its turn runs at; a refused one sends nothing.
  if (ready.ok && sessionId && planned.floor) notePoolFloorSent(sessionId, planned.floor);
  return ready;
}

/** `planned.floor` is set to the pool floor the chain was planned at, for a private chat. */
async function resolvedInferenceReady(
  sessionId: string | undefined,
  onApply: InferenceApplyListener | undefined,
  planned: { floor?: TrustLevel }
): Promise<InferenceReady> {
  // An apply may be restarting Hermes or moving it to a model that's about to be cancelled, so
  // this waits and then decides from what is true by then.
  const before = await resolveSessionInference(sessionId);
  await settleHermesApply(() => {
    if (before) onApply?.(before, false, true);
  });
  const resolved = await resolveSessionInference(sessionId);
  if (!resolved?.configured) {
    return {
      ok: false,
      error: 'No model is chosen, so your message wasn’t sent. Choose one in Inference.',
    };
  }
  const shared = resolved.slot === 'peer';
  const pool = resolved.slot === 'confidential';
  // llm-proxy goes through the router only on a managed stack, and a shared model or pool needs it.
  if ((shared || pool) && isLocalAssistantStackMode()) {
    return {
      ok: false,
      error: `${shared ? 'Shared models' : 'Confidential pools'} can’t serve in local-stack mode. Pick another model in Inference.`,
      errorCode: 'apply-failed',
    };
  }
  const fallbacks = resolved.fallbacks ?? [];
  const privacyLocked = sessionPrivacyLocked(sessionId);
  const projectFloor = sessionPoolFloor(sessionId, privacyLocked);
  if (projectFloor) planned.floor = projectFloor;
  const plan = await planResolved(resolved, privacyLocked, projectFloor);
  if (plan.kind === 'refused') {
    if (plan.privacy) return { ok: false, error: plan.error, errorCode: 'private-refused' };
    return {
      ok: false,
      error: plan.error,
      ...(shared ? { errorCode: 'apply-failed' as const, provider: resolved.peer?.providerId } : {}),
      ...(pool ? { errorCode: 'apply-failed' as const } : {}),
    };
  }
  if (plan.kind === 'routed') {
    if (plan.offline) {
      return { ok: false, error: plan.offline, errorCode: 'apply-failed', provider: resolved.peer?.providerId };
    }
    const llm =
      resolved.slot === 'peer'
        ? sharedModelConnection(resolved.modelId)
        : resolved.slot === 'confidential'
          ? poolConnection(resolved.modelId)
          : await getSlotLlmConnection(resolved.slot);
    if (!llm) {
      return { ok: false, error: 'That provider is not connected.', errorCode: 'apply-failed' };
    }
    const current = llmFingerprintsMatch(getLastAppliedLlm(), {
      slot: resolved.slot,
      endpointUrl: llm.endpointUrl,
      modelId: resolved.modelId,
      routed: true,
      contextLength: plan.chain.contextLength,
    });
    const needsApply = !(current && inferenceRouterPushed());
    // The router falls back on its own, so this stops only when nothing in the chain answers.
    if (needsApply || sharedProviderOffline(plan.chain.entries.map((state) => state.entry))) {
      const silent = await silentChainSlots(plan.chain.entries);
      if (silent) {
        return unanswered(silent, plan.chain.entries.some((state) => state.entry.slot === 'peer' && state.stale));
      }
    }
    if (!needsApply) {
      const privateTurns = runningPrivateTurns();
      if (privateTurns.running && reachesBelow(plan.chain, privateTurns.floor)) {
        return {
          ok: false,
          error:
            'A reply in a private project is still running, and this chat can use a model that ' +
            'isn’t private. Send again when it finishes.',
        };
      }
      // Same model and context for Hermes: only the router's chain changes (ADR 0033 §9).
      setInferenceRouterChain(plan.chain);
      return { ok: true, resolved };
    }
    return applyResolved(resolved, { ...llm, modelId: resolved.modelId, slot: resolved.slot, plan }, (restarting) =>
      onApply?.(resolved, false, restarting)
    );
  }
  // A shared model or pool is always routed, so what's left here is a slot's direct connection.
  if (resolved.slot === 'peer' || resolved.slot === 'confidential') {
    return {
      ok: false,
      error: resolved.slot === 'peer' ? 'That shared model has no route.' : 'That confidential pool has no route.',
      errorCode: 'apply-failed',
    };
  }
  // A chain that still lists a shared model is direct only because that model can't serve.
  const sharedUnavailable = !privacyLocked && fallbacks.some((entry) => entry.slot === 'peer');
  if (resolved.slot === 'local') {
    const probed = await probeSlotHealth('local');
    if (probed.health === 'unreachable') {
      return {
        ok: false,
        error: sharedUnavailable
          ? 'Your shared model isn’t available and your local model didn’t answer, so your message wasn’t sent.'
          : privacyLocked
            ? 'Local model unreachable. Retry when it’s back.'
            : 'Local model unreachable. Retry, or send this message via OpenRouter.',
        errorCode: 'local-unreachable',
        ...(sharedUnavailable ? { sharedUnavailable } : {}),
      };
    }
  }
  // Leaving a chain points llm-proxy back at the provider, which needs an apply.
  const needsApply = resolved.needsRestart || getLastAppliedLlm()?.routed === true;
  if (
    resolved.slot !== 'local' &&
    (needsApply || (sharedUnavailable && sharedProviderOffline(fallbacks))) &&
    !(await slotAnswers(resolved.slot))
  ) {
    return unanswered([slotAnswerName(resolved.slot)], sharedUnavailable);
  }
  if (needsApply) {
    const llm = await getSlotLlmConnection(resolved.slot);
    if (!llm) {
      return {
        ok: false,
        error: 'That provider is not connected.',
        errorCode: 'apply-failed',
      };
    }
    return applyResolved(resolved, { ...llm, modelId: resolved.modelId, slot: resolved.slot }, (restarting) =>
      onApply?.(resolved, sharedUnavailable, restarting)
    );
  }
  return { ok: true, resolved };
}

async function applyResolved(
  resolved: ResolvedSessionInference,
  connection: NonNullable<Parameters<typeof applyLlmConnectionToHermes>[0]>,
  onStep?: (restarting: boolean) => void
): Promise<InferenceReady> {
  // Applying can restart Hermes (and in managed mode switches the proxy's one upstream), which
  // would cut off any reply still running. Refuse rather than queue: the user sends again.
  if (listRunningTurns().length > 0) {
    return {
      ok: false,
      error:
        `Another reply is still running, and switching to ${resolved.providerDisplayName} would ` +
        'cut it off. Send again when it finishes.',
    };
  }
  onStep?.(false);
  const applied = await applyLlmConnectionToHermes(connection, { onRestart: () => onStep?.(true) });
  if (!applied.success) {
    return {
      ok: false,
      error: applied.error ?? 'Could not apply the inference connection.',
      errorCode: 'apply-failed',
    };
  }
  return { ok: true, resolved };
}

/** This app run, so a window a previous run left open can be told from a turn still running. */
const THIS_RUN = randomUUID();

/**
 * The chat's turn windows, oldest first. A window an earlier run left open (the app quit
 * mid-turn, while Hermes may have kept running it) ends where the next window that ran ends, or
 * never when there is none, so a reply of either turn sits in two windows and gets no line. A
 * window that ended at its own start (a send that never ran) is skipped, since it held nothing.
 */
function listTurnWindows(sessionId: string): TurnWindow[] {
  const stored = listSessionTurnWindows(sessionId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const windows: TurnWindow[] = stored.map((w) => ({ startedAt: w.startedAt, endedAt: w.endedAt }));
  const ran = (w: StoredTurnWindow): boolean => w.endedAt === null || w.endedAt > w.startedAt;
  for (let i = stored.length - 1; i >= 0; i -= 1) {
    if (stored[i].endedAt === null && stored[i].run !== THIS_RUN) {
      let next = i + 1;
      while (next < stored.length && !ran(stored[next])) next += 1;
      windows[i].endedAt = windows[next]?.endedAt ?? null;
    }
  }
  return windows;
}

/**
 * Opens the chat's window for a send that reached main, before its gate, so a reply is matched to
 * a turn only while that turn alone was running, whatever answers it, or if nothing does. Only
 * pool replies read windows, so nothing is written while pools are off.
 */
export function noteTurnStarted(sessionId: string, at: number): void {
  if (!chainPoolsEnabled()) return;
  appendSessionTurnWindow(sessionId, { startedAt: new Date(at).toISOString(), endedAt: null, run: THIS_RUN });
}

/**
 * Ends the window opened at `startedAt`, under the first of `sessionIds` that holds it: a resume
 * during the turn can move the chat's windows to a new id. Nothing while pools are off.
 */
export function noteTurnEnded(sessionIds: readonly string[], startedAt: number, endedAt: number): void {
  if (!chainPoolsEnabled()) return;
  const started = new Date(startedAt).toISOString();
  const ended = new Date(Math.max(endedAt, startedAt)).toISOString();
  for (const id of new Set(sessionIds)) {
    if (closeSessionTurnWindow(id, started, ended)) return;
  }
}

/**
 * The router's answer for this turn: the session's own record first, else the latest of any
 * session, and only one for a request sent since the turn began. Hermes titles a chat and reviews
 * its memory after a turn with the chat's session key, and those requests can go to another entry.
 */
function servedThisTurn(sessionId: string, turnStartedAt: number): RouterServed | null {
  for (const served of [latestInferenceRouterServed(sessionId), latestInferenceRouterServed()]) {
    if (served && served.requestedAt >= turnStartedAt) return served;
  }
  return null;
}

/**
 * After a turn a pool answered: which provider, its catalog name and level (spec decision 9),
 * and the turn's move: the last any of its requests made, since later ones stay and report none.
 * Recorded only from an answer carrying this chat's session key, and only when Boundary's
 * provider list names the provider, so a reply's line can be missing but never wrong.
 */
function notePoolServed(
  sessionId: string,
  served: RouterServed | null,
  turnStartedAt: number,
  poolTurn: RouterPoolTurn,
  windowStartedAt: number | null
): void {
  if (!served?.pool || served.sessionKey !== sessionId) return;
  const label = poolProviderLabel(served.pool.providerId);
  if (!label) return;
  appendPoolServedTurn(sessionId, {
    at: new Date(turnStartedAt).toISOString(),
    windowStartedAt: windowStartedAt == null ? null : new Date(windowStartedAt).toISOString(),
    modelId: served.modelId,
    providerId: served.pool.providerId,
    providerName: label.name,
    level: label.level,
    moved: poolTurn.moved ?? served.pool.moved,
    mixedProviders: poolTurn.mixedProviders,
  });
}

/**
 * After a turn: when a fallback answered its last request, mark the chat so the transcript says
 * which provider answers from that reply on (ADR 0033 §3), and mark it again when the primary next
 * answers, so the chip knows the fallback is over. The router's record for the chat's session is
 * read first; without one, its latest answer for any chat, trusted only if given since the turn
 * began. A run of turns on the same fallback is marked once. A turn past the router, on a chain
 * cut to one entry, went to the primary if it replied at all. A turn a pool answered also records
 * its provider.
 */
export function noteFallbackServed(
  sessionId: string,
  turnStartedAt: number,
  replied = false,
  /** The turn's window (`noteTurnStarted`), which its pool record names. */
  windowStartedAt: number | null = null
): void {
  const last = listSessionInferenceMarks(sessionId).at(-1);
  const latest = servedThisTurn(sessionId, turnStartedAt);
  notePoolServed(sessionId, latest, turnStartedAt, takeInferenceRouterPoolTurn(sessionId, turnStartedAt), windowStartedAt);
  const applied = getLastAppliedLlm();
  const served: Pick<RouterServed, 'slot' | 'modelId' | 'peer' | 'fellBack'> | null = latest
    ? latest
    : replied && applied && !applied.routed
      ? { slot: applied.slot, modelId: applied.modelId, fellBack: false }
      : null;
  if (!served || (!served.fellBack && last?.kind !== 'fell-back')) return;
  const provider = served.slot === 'peer' ? served.slot : isVisibleChatProvider(served.slot) ? served.slot : null;
  if (!provider) return;
  if (served.fellBack && last?.kind === 'fell-back' && last.provider === provider && last.modelId === served.modelId) {
    return;
  }
  const sharedBy = served.peer ? sharedProviderNames(served.peer) : null;
  // Dated from the turn's start, so the mark sits above the reply it begins with.
  appendSessionInferenceMark(
    sessionId,
    {
      kind: served.fellBack ? 'fell-back' : 'recovered',
      provider,
      modelId: served.modelId,
      ...(sharedBy ? { sharedBy } : {}),
    },
    new Date(turnStartedAt)
  );
}
