import { inferenceSlotLabel, isVisibleChatProvider } from '../../../../shared/inferenceDisplay';
import type { InferenceChainEntry, InferenceChainEntryState } from '../../../../shared/types/inferenceChain';
import type { InferenceSlotId } from '../../../../shared/types/onboarding';
import type {
  HermesChatStartErrorCode,
  HermesSessionInferenceResult,
  HermesSessionInferenceSetPayload,
  ResolvedSessionInference,
} from '../../../../shared/types/hermesChat';
import { probeSlotHealth } from '../../onboarding/probeSlotHealth';
import { getSlotLlmConnection, keepChainFallbacks } from '../../onboarding/OpenAiOnboardingStore';
import { applyLlmConnectionToHermes, settleHermesApply } from '../AssistantStackService';
import { getLastAppliedLlm, llmFingerprintsMatch } from '../AssistantStackStore';
import { sharedModelFacts, sharedProviderNames } from '../../circles/circlesService';
import { planInferenceChain, sharedModelConnection } from '../../inference/inferenceChainService';
import { isLocalAssistantStackMode } from '../localStackMode';
import {
  inferenceRouterPushed,
  latestInferenceRouterServed,
  setInferenceRouterChain,
} from '../../inference/inferenceRouterService';
import type { RouterServed } from '../../inference/router/chainRouter';
import {
  appendSessionInferenceMark,
  clearSessionInference,
  getSessionInference,
  listSessionInferenceMarks,
  setSessionInference,
} from './hermesAgentStore';
import { resolveSessionInference, sessionPrivacyLocked } from './resolveSessionInference';
import { listRunningTurns } from './hermesRunningTurns';

/** The level's whole chain, cut by the lock: the one answer the send and the chip both use. */
async function planResolved(resolved: ResolvedSessionInference, privacyLocked: boolean) {
  // The level that supplied the model supplies the whole chain (ADR 0033 §1).
  const fallbacks = resolved.fallbacks ?? [];
  return fallbacks.length || privacyLocked || resolved.slot === 'peer'
    ? planInferenceChain(
        { slot: resolved.slot, modelId: resolved.modelId, ...(resolved.peer ? { peer: resolved.peer } : {}) },
        fallbacks,
        { privacyLocked }
      )
    : ({ kind: 'direct' } as const);
}

/** What the chat's UI shows: the resolved inference and whether the privacy lock stops a send. */
async function resolveForChat(sessionId: string | null): Promise<ResolvedSessionInference | null> {
  const resolved = await resolveSessionInference(sessionId);
  if (!resolved || !sessionPrivacyLocked(sessionId)) return resolved;
  const plan = resolved.configured ? await planResolved(resolved, true) : null;
  return {
    ...resolved,
    privacyLocked: true,
    privacyRefused: plan?.kind === 'refused' && plan.privacy === true,
  };
}

/** A private turn's next request goes to the router's current chain, so it can't take a wider one. */
function privateTurnRunning(): boolean {
  return listRunningTurns().some((turn) => turn.sessionIds.some((id) => sessionPrivacyLocked(id)));
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
      error: 'Missing session.',
    };
  }
  return {
    success: true,
    override: getSessionInference(sessionId),
    resolved: await resolveForChat(sessionId),
    marks: listSessionInferenceMarks(sessionId),
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

/** The chain's slots when none of them answers and no online member can serve; otherwise null. */
async function silentChainSlots(entries: InferenceChainEntryState[]): Promise<string[] | null> {
  const usable = entries.filter((state) => !state.stale).map((state) => state.entry.slot);
  if (usable.includes('peer')) return null;
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
      error: 'No model is chosen, so your message wasn’t sent. Connect a provider or choose a shared model in Settings.',
    };
  }
  const shared = resolved.slot === 'peer';
  // llm-proxy goes through the router only on a managed stack, and a shared model needs it.
  if (shared && isLocalAssistantStackMode()) {
    return {
      ok: false,
      error: 'Shared models can’t serve in local-stack mode. Pick another model in Settings.',
      errorCode: 'apply-failed',
    };
  }
  const fallbacks = resolved.fallbacks ?? [];
  const privacyLocked = sessionPrivacyLocked(sessionId);
  const plan = await planResolved(resolved, privacyLocked);
  if (plan.kind === 'refused') {
    if (plan.privacy) return { ok: false, error: plan.error, errorCode: 'private-refused' };
    return {
      ok: false,
      error: plan.error,
      ...(shared ? { errorCode: 'apply-failed' as const, provider: resolved.peer?.providerId } : {}),
    };
  }
  if (plan.kind === 'routed') {
    if (plan.offline) {
      return { ok: false, error: plan.offline, errorCode: 'apply-failed', provider: resolved.peer?.providerId };
    }
    const llm =
      resolved.slot === 'peer' ? sharedModelConnection(resolved.modelId) : await getSlotLlmConnection(resolved.slot);
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
      if (plan.chain.entries.some((state) => !state.private) && privateTurnRunning()) {
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
  // A shared model is always routed, so what's left here is a slot's direct connection.
  if (resolved.slot === 'peer') {
    return { ok: false, error: 'That shared model has no route.', errorCode: 'apply-failed' };
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

/**
 * After a turn: when a fallback answered its last request, mark the chat so the transcript says
 * which provider answers from that reply on (ADR 0033 §3), and mark it again when the primary next
 * answers, so the chip knows the fallback is over. The router can't tell chats apart (change request 0014 R3), so
 * this reads its latest answer and only trusts one given since the turn began. A run of turns on
 * the same fallback is marked once. A turn past the router, on a chain cut to one entry, went to
 * the primary if it replied at all.
 */
export function noteFallbackServed(sessionId: string, turnStartedAt: number, replied = false): void {
  const last = listSessionInferenceMarks(sessionId).at(-1);
  const latest = latestInferenceRouterServed();
  const applied = getLastAppliedLlm();
  const served: Pick<RouterServed, 'slot' | 'modelId' | 'peer' | 'fellBack'> | null =
    latest && latest.at >= turnStartedAt
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
