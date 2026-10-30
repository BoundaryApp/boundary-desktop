import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ResolvedSessionInference,
  SessionInferenceMark,
  SessionInferenceOverride,
} from '../../../shared/types/hermesChat';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useInferenceSendHandlers } from './HermesChatRuntimeProvider';

/**
 * The chat's inference as the chip resolves it, the switch marks, the offline prompt shown when
 * a send finds the local model unreachable (retry it, or send via OpenRouter), and the prompt
 * shown while a private project's chat has no private model to send to.
 */
export function useChatInference({
  sessionId,
  send,
}: {
  sessionId: string | null;
  /** Sends what is in the composer, with any waiting quote. */
  send: () => void;
}) {
  const [inferenceMarks, setInferenceMarks] = useState<SessionInferenceMark[]>([]);
  const [resolvedInference, setResolvedInference] = useState<ResolvedSessionInference | null>(
    null
  );
  const [offlinePrompt, setOfflinePrompt] = useState(false);
  // Bumped after the offline prompt changes main's state, so the chip re-resolves.
  const [refreshKey, setRefreshKey] = useState(0);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Main refused a send the last answer allowed, or a chat with no chip to answer.
  const [refusedSend, setRefusedSend] = useState(false);
  const slots = useInferenceStatus().status?.slots;
  const openRouterSlot = slots?.openrouter;
  const privacyLocked = resolvedInference?.privacyLocked === true;
  // A private project never offers the cloud (ADR 0033 §4); main refuses it anyway.
  const openRouterConfigured =
    !privacyLocked && Boolean(openRouterSlot?.configured && openRouterSlot.modelId);
  const localSlot = slots?.local;
  const localModelId = localSlot?.configured ? (localSlot.modelId ?? null) : null;
  // Send via OpenRouter before the chat has a session: its first send carries the choice.
  const newChatInferenceRef = useRef<SessionInferenceOverride | null>(null);

  useInferenceSendHandlers({
    onLocalUnreachable: () => {
      setOfflinePrompt(true);
      setApplyError(null);
    },
    onApplyFailed: (error) => {
      setApplyError(error);
      setOfflinePrompt(false);
    },
    onPrivateRefused: () => {
      setRefusedSend(true);
      setRefreshKey((n) => n + 1);
    },
    takeNewChatInference: () => {
      const inference = newChatInferenceRef.current;
      newChatInferenceRef.current = null;
      return inference;
    },
  });

  // The prompt is about the local model; it goes when the chat moves off it.
  useEffect(() => {
    if (resolvedInference?.slot !== 'local') setOfflinePrompt(false);
  }, [resolvedInference]);

  useEffect(() => {
    if (resolvedInference && !resolvedInference.privacyRefused) setRefusedSend(false);
  }, [resolvedInference]);
  useEffect(() => setRefusedSend(false), [sessionId]);

  /** False, and the prompt shows, when the chat's local model is known to be unreachable. */
  const checkReachable = useCallback((): boolean => {
    if (resolvedInference?.slot === 'local' && resolvedInference.health === 'unreachable') {
      setOfflinePrompt(true);
      return false;
    }
    return true;
  }, [resolvedInference]);

  const retryLocal = useCallback(async () => {
    const probed = await window.electronAPI.onboarding.probeSlotHealth({ slot: 'local' });
    if (probed.status) void takeInferenceStatus(probed);
    setRefreshKey((n) => n + 1);
    if (probed.health !== 'reachable') return;
    setOfflinePrompt(false);
    send();
  }, [send]);

  const sendViaOpenRouter = useCallback(async () => {
    const modelId = openRouterSlot?.modelId;
    if (!openRouterSlot?.configured || !modelId) return;
    if (sessionId) {
      await window.electronAPI.hermesChat.setSessionInference({
        sessionId,
        provider: 'openrouter',
        modelId,
      });
      setRefreshKey((n) => n + 1);
    } else {
      // The chip re-resolves when the send gives the chat its session.
      newChatInferenceRef.current = { provider: 'openrouter', modelId };
    }
    setOfflinePrompt(false);
    send();
  }, [send, openRouterSlot, sessionId]);

  const sendViaLocal = useCallback(async () => {
    if (!localModelId) return;
    if (sessionId) {
      await window.electronAPI.hermesChat.setSessionInference({
        sessionId,
        provider: 'local',
        modelId: localModelId,
      });
      setRefreshKey((n) => n + 1);
    } else {
      newChatInferenceRef.current = { provider: 'local', modelId: localModelId };
    }
    setRefusedSend(false);
    send();
  }, [send, localModelId, sessionId]);

  const refreshAfterTurn = useCallback(() => setRefreshKey((n) => n + 1), []);

  return {
    inferenceMarks,
    refreshAfterTurn,
    setInferenceMarks,
    setResolvedInference,
    offlinePrompt,
    applyError,
    refreshKey,
    openRouterConfigured,
    privateRefused: refusedSend || resolvedInference?.privacyRefused === true,
    localModelId,
    sendViaLocal,
    checkReachable,
    retryLocal,
    sendViaOpenRouter,
  };
}
