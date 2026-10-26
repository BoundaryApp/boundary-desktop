import { inferenceSlotLabel } from '../../../../shared/inferenceDisplay';
import type { ResolvedSessionInference } from '../../../../shared/types/hermesChat';
import type { InferenceSlotId } from '../../../../shared/types/onboarding';
import {
  getLastAppliedLlm,
  llmFingerprintsMatch,
} from '../AssistantStackStore';
import {
  getAppDefaultSlot,
  getSlotHealth,
  getSlotLlmConnection,
  type LlmConnection,
} from '../../onboarding/OpenAiOnboardingStore';
import { getSessionInference } from './hermesAgentStore';
import { getActiveHermesProjectId, getStoredHermesProject } from './hermesProjectStore';
import { conversationProjectId } from './hermesChatProjects';

function buildResolved(
  slot: InferenceSlotId,
  connection: LlmConnection,
  provenance: ResolvedSessionInference['provenance']
): ResolvedSessionInference {
  const lastApplied = getLastAppliedLlm();
  return {
    slot,
    modelId: connection.modelId,
    providerDisplayName:
      connection.providerDisplayName?.trim() || inferenceSlotLabel(slot),
    provenance,
    configured: true,
    health: getSlotHealth(slot),
    needsRestart: !llmFingerprintsMatch(lastApplied, {
      slot,
      endpointUrl: connection.endpointUrl,
      modelId: connection.modelId,
    }),
  };
}

async function resolveAppDefault(): Promise<ResolvedSessionInference | null> {
  const appDefault = getAppDefaultSlot();
  if (!appDefault) return null;
  const connection = await getSlotLlmConnection(appDefault);
  if (!connection) {
    return {
      slot: appDefault,
      modelId: '',
      providerDisplayName: inferenceSlotLabel(appDefault),
      provenance: 'app-default',
      configured: false,
      health: getSlotHealth(appDefault),
      needsRestart: false,
    };
  }
  return buildResolved(appDefault, connection, 'app-default');
}

/**
 * Phase 3 resolver: chat override → the chat's project pin → app default. A chat's own
 * project applies, never the rail's (ADR 0024 §2). With no session yet (an empty composer)
 * the chat will start in the rail's project, so that pin shows.
 * `getLlmConnection()` stays the machine default — do not call this from Settings apply.
 */
export async function resolveSessionInference(
  sessionId?: string | null
): Promise<ResolvedSessionInference | null> {
  const override = sessionId ? getSessionInference(sessionId) : null;
  if (override) {
    const connection = await getSlotLlmConnection(override.provider);
    if (connection) {
      const modelId = override.modelId.trim() || connection.modelId;
      return buildResolved(
        override.provider,
        { ...connection, modelId },
        'chat-override'
      );
    }
  }

  const projectId = sessionId ? conversationProjectId(sessionId) : getActiveHermesProjectId();
  const project = projectId ? getStoredHermesProject(projectId) : null;
  const pin = project?.inference;
  if (pin && pin.mode !== 'inherit') {
    const connection = await getSlotLlmConnection(pin.mode);
    if (connection) {
      const modelId = pin.modelId?.trim() || connection.modelId;
      return buildResolved(
        pin.mode,
        { ...connection, modelId },
        'project-default'
      );
    }
  }

  return resolveAppDefault();
}
