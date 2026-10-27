import type {
  HermesChatStartErrorCode,
  HermesSessionInferenceResult,
  HermesSessionInferenceSetPayload,
  ResolvedSessionInference,
} from '../../../../shared/types/hermesChat';
import { probeSlotHealth } from '../../onboarding/probeSlotHealth';
import { getSlotLlmConnection } from '../../onboarding/OpenAiOnboardingStore';
import { applyLlmConnectionToHermes } from '../AssistantStackService';
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
  setSessionInference(sessionId, { provider: payload.provider, modelId });
  if (prior?.provider !== payload.provider || prior.modelId !== modelId) {
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
  if (resolved.needsRestart) {
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
    const llm = await getSlotLlmConnection(resolved.slot);
    if (!llm) {
      return {
        ok: false,
        error: 'That provider is not connected.',
        errorCode: 'apply-failed',
      };
    }
    const applied = await applyLlmConnectionToHermes({
      ...llm,
      modelId: resolved.modelId,
      slot: resolved.slot,
    });
    if (!applied.success) {
      return {
        ok: false,
        error: applied.error ?? 'Could not apply the inference connection.',
        errorCode: 'apply-failed',
      };
    }
  }
  return { ok: true, resolved };
}
