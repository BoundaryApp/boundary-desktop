import type {
  HermesChatStartErrorCode,
  HermesSessionInferenceResult,
  HermesSessionInferenceSetPayload,
  ResolvedSessionInference,
} from '../../../../shared/types/hermesChat';
import { probeSlotHealth } from '../../onboarding/probeSlotHealth';
import { getSlotLlmConnection, keepChainFallbacks } from '../../onboarding/OpenAiOnboardingStore';
import { applyLlmConnectionToHermes } from '../AssistantStackService';
import { getLastAppliedLlm, llmFingerprintsMatch } from '../AssistantStackStore';
import { planInferenceChain } from '../../inference/inferenceChainService';
import {
  inferenceRouterPushed,
  latestInferenceRouterServed,
  setInferenceRouterChain,
} from '../../inference/inferenceRouterService';
import { isVisibleChatProvider } from '../../../../shared/inferenceDisplay';
import {
  appendSessionInferenceMark,
  clearSessionInference,
  getSessionInference,
  listSessionInferenceMarks,
  setSessionInference,
} from './hermesAgentStore';
import { resolveSessionInference } from './resolveSessionInference';
import { listRunningTurns } from './hermesRunningTurns';

export async function getSessionInferenceSnapshot(
  sessionId: string
): Promise<HermesSessionInferenceResult> {
  if (!sessionId.trim()) {
    return {
      success: false,
      override: null,
      resolved: await resolveSessionInference(null),
      marks: [],
      error: 'Missing session.',
    };
  }
  return {
    success: true,
    override: getSessionInference(sessionId),
    resolved: await resolveSessionInference(sessionId),
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
  const connection = await getSlotLlmConnection(payload.provider);
  if (!connection) {
    return {
      success: false,
      override: getSessionInference(sessionId),
      resolved: await resolveSessionInference(sessionId),
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
      resolved: await resolveSessionInference(sessionId),
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
      resolved: await resolveSessionInference(null),
      marks: [],
      error: 'Missing session.',
    };
  }
  clearSessionInference(id);
  return getSessionInferenceSnapshot(id);
}

export async function ensureResolvedInferenceReady(
  sessionId: string | undefined,
  onRestarting?: (resolved: ResolvedSessionInference) => void
): Promise<
  | { ok: true; resolved: ResolvedSessionInference }
  | { ok: false; error: string; errorCode?: HermesChatStartErrorCode }
> {
  const resolved = await resolveSessionInference(sessionId);
  if (!resolved?.configured) {
    return { ok: false, error: 'No configured LLM connection.' };
  }
  // The level that supplied the model supplies the whole chain (ADR 0033 §1).
  const fallbacks = resolved.fallbacks ?? [];
  const plan = fallbacks.length
    ? await planInferenceChain({ slot: resolved.slot, modelId: resolved.modelId }, fallbacks)
    : ({ kind: 'direct' } as const);
  if (plan.kind === 'refused') return { ok: false, error: plan.error };
  if (plan.kind === 'routed') {
    // The router falls back on its own, so an unreachable local model is no reason to stop.
    const llm = await getSlotLlmConnection(resolved.slot);
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
    if (current && inferenceRouterPushed()) {
      // Same model and context for Hermes: only the router's chain changes (ADR 0033 §9).
      setInferenceRouterChain(plan.chain);
      return { ok: true, resolved };
    }
    return applyResolved(resolved, { ...llm, modelId: resolved.modelId, slot: resolved.slot, plan }, onRestarting);
  }
  if (resolved.slot === 'local') {
    const probed = await probeSlotHealth('local');
    if (probed.health === 'unreachable') {
      return {
        ok: false,
        error: 'Local model unreachable. Retry, or send this message via OpenRouter.',
        errorCode: 'local-unreachable',
      };
    }
  }
  // Leaving a chain points llm-proxy back at the provider, which needs an apply.
  if (resolved.needsRestart || getLastAppliedLlm()?.routed) {
    const llm = await getSlotLlmConnection(resolved.slot);
    if (!llm) {
      return {
        ok: false,
        error: 'That provider is not connected.',
        errorCode: 'apply-failed',
      };
    }
    return applyResolved(resolved, { ...llm, modelId: resolved.modelId, slot: resolved.slot }, onRestarting);
  }
  return { ok: true, resolved };
}

async function applyResolved(
  resolved: ResolvedSessionInference,
  connection: NonNullable<Parameters<typeof applyLlmConnectionToHermes>[0]>,
  onRestarting?: (resolved: ResolvedSessionInference) => void
): Promise<
  | { ok: true; resolved: ResolvedSessionInference }
  | { ok: false; error: string; errorCode?: HermesChatStartErrorCode }
> {
  // Applying restarts Hermes (and in managed mode switches the proxy's one upstream), which
  // would cut off any reply still running. Refuse rather than queue: the user sends again.
  if (listRunningTurns().length > 0) {
    return {
      ok: false,
      error:
        `Another reply is still running. Switching to ${resolved.providerDisplayName} restarts ` +
        'the assistant, which would cut it off. Send again when it finishes.',
    };
  }
  onRestarting?.(resolved);
  const applied = await applyLlmConnectionToHermes(connection);
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
 * which provider answered (ADR 0033 §3). The router can't tell chats apart (change request 0014
 * R3), so this reads its latest answer and only trusts one given since the turn began. A run of
 * turns on the same fallback is marked once.
 */
export function noteFallbackServed(sessionId: string, turnStartedAt: number): void {
  const served = latestInferenceRouterServed();
  if (!served?.fellBack || served.at < turnStartedAt || !isVisibleChatProvider(served.slot)) return;
  const last = listSessionInferenceMarks(sessionId).at(-1);
  if (last?.kind === 'fell-back' && last.provider === served.slot && last.modelId === served.modelId) return;
  appendSessionInferenceMark(sessionId, { kind: 'fell-back', provider: served.slot, modelId: served.modelId });
}
