import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HermesProjectRecord,
  PoolServedTurn,
  ResolvedSessionInference,
  SessionInferenceMark,
  SessionInferenceOverride,
  TurnWindow,
} from '../../../shared/types/hermesChat';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import { useInferenceSendHandlers } from './HermesChatRuntimeProvider';
import { projectInferenceKey as projectKeyOf } from './projectInferenceKey';
import { patchProjectInference, type PatchProjectInference } from './useProjects';
import { useOnChatSwitch } from './useOnChatSwitch';

/**
 * What main resolves for a chat: its inference, the switch marks and the turns a confidential pool
 * answered, with a local chat's health probed. With no session yet main answers for a new chat:
 * the rail project's pin, else the app default, which is what the first turn will use.
 */
export function useSessionInference({
  sessionId,
  projectInferenceKey = null,
}: {
  sessionId: string | null;
  /** Fingerprint of the chat's project pin, so the chat re-resolves after the pin changes. */
  projectInferenceKey?: string | null;
}) {
  const [resolved, setResolved] = useState<ResolvedSessionInference | null>(null);
  const [marks, setMarks] = useState<SessionInferenceMark[]>([]);
  const [poolTurns, setPoolTurns] = useState<PoolServedTurn[]>([]);
  const [turnWindows, setTurnWindows] = useState<TurnWindow[]>([]);
  const { status } = useInferenceStatus();

  // Only the latest refresh may publish: a slow answer for the previous chat is dropped.
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    const publish = (
      next: ResolvedSessionInference | null,
      nextMarks?: SessionInferenceMark[],
      pool?: { turns: PoolServedTurn[]; windows: TurnWindow[] }
    ) => {
      if (mine !== latest.current) return;
      setResolved(next);
      if (nextMarks) setMarks(nextMarks);
      if (pool) {
        setPoolTurns(pool.turns);
        setTurnWindows(pool.windows);
      }
    };
    try {
      const snapshot = await window.electronAPI.hermesChat.getSessionInference({
        sessionId: sessionId ?? '',
      });
      publish(snapshot.resolved, snapshot.marks, {
        turns: snapshot.poolTurns ?? [],
        windows: snapshot.turnWindows ?? [],
      });
      if (snapshot.resolved?.slot !== 'local' || mine !== latest.current) return;
      const probed = await window.electronAPI.onboarding.probeSlotHealth({ slot: 'local' });
      if (probed.status) void takeInferenceStatus(probed);
      publish({ ...snapshot.resolved, health: probed.health });
    } catch {
      publish(null, [], { turns: [], windows: [] });
    }
    // projectInferenceKey changes what main answers, not what this asks.
  }, [sessionId, projectInferenceKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Main pushes the local model's health when it changes; a chat on Local takes it, so the
  // offline prompt shows (or clears) without a send or a reopened menu.
  const localHealth = status?.slots.local?.health;
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;
  useEffect(() => {
    const current = resolvedRef.current;
    if (!localHealth || current?.slot !== 'local' || current.health === localHealth) return;
    setResolved({ ...current, health: localHealth });
  }, [localHealth]);

  return { resolved, marks, poolTurns, turnWindows, refresh };
}

/**
 * The chat's inference as main resolves it, the switch marks, the offline prompt shown when
 * a send finds the local model unreachable (retry it, or send via OpenRouter), and the prompt
 * shown while a private project's chat has no private model to send to.
 */
export function useChatInference({
  sessionId,
  sameChat,
  send,
  project = null,
  patchInference = patchProjectInference,
  takeNewChatWritingVoice,
}: {
  sessionId: string | null;
  /** Whether two ids name the same chat (a runtime id and its stored id). */
  sameChat?: (a: string, b: string) => boolean;
  /** Sends what is in the composer, with any waiting quote. */
  send: () => void;
  /** The chat's project, where Allow level B is stored. */
  project?: HermesProjectRecord | null;
  /** Saves the project's pin and updates the project list; defaults to no list. */
  patchInference?: PatchProjectInference;
  /** A writing voice kept for a chat with no session yet (ADR 0056 §6). */
  takeNewChatWritingVoice?: () => string | null;
}) {
  const session = useSessionInference({ sessionId, projectInferenceKey: projectKeyOf(project) });
  const { resolved: resolvedInference, refresh } = session;
  // The send handlers and the noted-turn listener outlive a render; they re-resolve the latest chat.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const [offlinePrompt, setOfflinePrompt] = useState(false);
  // Main refused a send the last answer allowed.
  const [refusedSend, setRefusedSend] = useState(false);
  // Allow level B from the pool stop: patching the project, and why that failed.
  const [allowingLevelB, setAllowingLevelB] = useState(false);
  const [allowLevelBError, setAllowLevelBError] = useState<string | null>(null);
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
    },
    onPrivateRefused: () => {
      setRefusedSend(true);
      void refreshRef.current();
    },
    takeNewChatInference: () => {
      const inference = newChatInferenceRef.current;
      newChatInferenceRef.current = null;
      return inference;
    },
    takeNewChatWritingVoice: () => takeNewChatWritingVoice?.() ?? null,
  });

  // The prompt is about the local model; it goes when the chat moves off it.
  useEffect(() => {
    if (resolvedInference?.slot !== 'local') setOfflinePrompt(false);
  }, [resolvedInference]);

  useEffect(() => {
    if (resolvedInference && !resolvedInference.privacyRefused) setRefusedSend(false);
  }, [resolvedInference]);
  useEffect(() => setAllowLevelBError(null), [resolvedInference]);
  // A new chat's first send adopting its id is the same chat: a refusal it got stays shown.
  useOnChatSwitch(sessionId, sameChat, () => {
    setRefusedSend(false);
    setAllowLevelBError(null);
  });

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
    void refresh();
    if (probed.health !== 'reachable') return;
    setOfflinePrompt(false);
    send();
  }, [send, refresh]);

  const sendViaOpenRouter = useCallback(async () => {
    const modelId = openRouterSlot?.modelId;
    if (!openRouterSlot?.configured || !modelId) return;
    if (sessionId) {
      await window.electronAPI.hermesChat.setSessionInference({
        sessionId,
        provider: 'openrouter',
        modelId,
      });
      void refresh();
    } else {
      // The chat re-resolves when the send gives it its session.
      newChatInferenceRef.current = { provider: 'openrouter', modelId };
    }
    setOfflinePrompt(false);
    send();
  }, [send, openRouterSlot, sessionId, refresh]);

  const sendViaLocal = useCallback(async () => {
    if (!localModelId) return;
    if (sessionId) {
      await window.electronAPI.hermesChat.setSessionInference({
        sessionId,
        provider: 'local',
        modelId: localModelId,
      });
      void refresh();
    } else {
      newChatInferenceRef.current = { provider: 'local', modelId: localModelId };
    }
    setRefusedSend(false);
    send();
  }, [send, localModelId, sessionId, refresh]);

  /** Stores Allow level B on the chat's project, as its inspector's Don't allow undoes, then resends. */
  const allowLevelB = useCallback(async () => {
    if (!project || allowingLevelB) return;
    setAllowingLevelB(true);
    setAllowLevelBError(null);
    const error = await patchInference(project.id, {
      mode: project.inference?.mode ?? 'inherit',
      ...project.inference,
      allowConfidentialLevelB: true,
    });
    setAllowingLevelB(false);
    if (error) {
      setAllowLevelBError(error);
      return;
    }
    void refresh();
    setRefusedSend(false);
    send();
  }, [allowingLevelB, patchInference, project, send, refresh]);

  // Main notes a turn's fallback mark and pool provider once the turn is over, then says so:
  // fetch them then, not on the reply's end, which comes first (ADR 0033 §3, spec decision 9).
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;
  useEffect(() => {
    if (!sessionId) return;
    return window.electronAPI.hermesChat.onInferenceNoted(({ sessionIds }) => {
      const same = sameChatRef.current ?? ((a: string, b: string) => a === b);
      if (sessionIds.some((id) => id === sessionId || same(id, sessionId))) void refreshRef.current();
    });
  }, [sessionId]);

  return {
    resolved: resolvedInference,
    inferenceMarks: session.marks,
    poolTurns: session.poolTurns,
    turnWindows: session.turnWindows,
    /** Asks main again, after something outside the chat changed what it resolves. */
    refresh,
    offlinePrompt,
    openRouterConfigured,
    privateRefused: refusedSend || resolvedInference?.privacyRefused === true,
    /** Why a private send stopped at a pool, per provider; only with `privateRefused`. */
    poolStop: resolvedInference?.poolStop ?? null,
    allowLevelB: project ? allowLevelB : undefined,
    allowingLevelB,
    allowLevelBError,
    /** The chat's model, for a reply shared to a Circle. */
    modelId: resolvedInference?.modelId ?? null,
    localModelId,
    sendViaLocal,
    checkReachable,
    retryLocal,
    sendViaOpenRouter,
  };
}
