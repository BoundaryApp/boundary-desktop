import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ResolvedSessionInference,
  SessionInferenceMark,
  SessionInferenceOverride,
} from '../../../shared/types/hermesChat';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useInferenceSendHandlers } from './HermesChatRuntimeProvider';

/**
 * The chat's inference as the chip resolves it, the switch marks, and the offline prompt
 * shown when a send finds the local model unreachable (retry it, or send via OpenRouter).
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
  const openRouterSlot = useInferenceStatus().status?.slots.openrouter;
  const openRouterConfigured = Boolean(openRouterSlot?.configured && openRouterSlot.modelId);
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

  return {
    inferenceMarks,
    setInferenceMarks,
    setResolvedInference,
    offlinePrompt,
    applyError,
    refreshKey,
    openRouterConfigured,
    checkReachable,
    retryLocal,
    sendViaOpenRouter,
  };
}
