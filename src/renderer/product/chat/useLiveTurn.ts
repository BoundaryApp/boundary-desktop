import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HermesChatContextBreakdown,
  HermesChatPhase,
  HermesChatPhaseEvent,
  HermesChatTurnStats,
  HermesChatUsageSnapshot,
  HermesHistoryWindow,
} from '../../../shared/types/hermesChat';
import {
  formatTurnStatsLine,
  toHostRelativePath,
  uniquePreserveOrder,
} from '../../../shared/hermesToolPaths';
import { isOwnedRunningTurn, useRunningTurns } from './runningTurns';
import { clearSetupOffer, recordSetupOffer, setupOfferKind } from './setupOffers';
import { projectPathsOf } from './MessageActions';
import { withToolEvent, type ToolCardState } from './ToolCards';

type SameChat = (a: string, b: string) => boolean;

/**
 * Runs `onSwitch` on mount and whenever the thread shows another chat. The open chat getting
 * its real session id (a DM placeholder's first send) is the same chat, so it does not count.
 */
export function useOnChatSwitch(
  sessionId: string | null,
  sameChat: SameChat | undefined,
  onSwitch: () => void
): void {
  const shownChatRef = useRef(sessionId);
  const onSwitchRef = useRef(onSwitch);
  onSwitchRef.current = onSwitch;
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;
  useEffect(() => {
    const prev = shownChatRef.current;
    shownChatRef.current = sessionId;
    if (prev && sessionId && prev !== sessionId && sameChatRef.current?.(prev, sessionId)) return;
    onSwitchRef.current();
  }, [sessionId]);
}

export interface LiveTurn {
  phaseEvent: HermesChatPhaseEvent | null;
  phase: HermesChatPhase;
  /** Preparing, restarting, running a tool or generating. */
  livePhase: boolean;
  usage: HermesChatUsageSnapshot | null;
  /** The cards to draw now: the live turn's, while it runs past preparing. */
  visibleToolCards: ToolCardState[];
  toggleToolCard: (toolId: string) => void;
  /** The finished turn's token stats, up to four rows. */
  statsRows: ReturnType<typeof formatTurnStatsLine>;
  /** The agent speaking in the live turn (rooms), or null. */
  liveSpeakerSlug: string | null;
  /** The DM's context horizon as the stack reports it (CR 0002 R2). */
  historyWindow: HermesHistoryWindow | null;
  /** What fills the context window now, for the meter split. */
  contextCategories: HermesChatContextBreakdown['categories'] | null;
}

/**
 * The open chat's live turn: phase, tool cards, stats and speaker. Events arrive for every
 * running turn; this keeps the open chat's own (another chat's "Preparing…" here would look
 * like the reply is coming to this chat).
 */
export function useLiveTurn({
  sessionId,
  sameChat,
  containerPath,
  isDm,
  hasMessages,
}: {
  sessionId: string | null;
  sameChat?: SameChat;
  containerPath: string | null | undefined;
  isDm: boolean;
  hasMessages: boolean;
}): LiveTurn {
  const [phaseEvent, setPhaseEvent] = useState<HermesChatPhaseEvent | null>(null);
  const [usage, setUsage] = useState<HermesChatUsageSnapshot | null>(null);
  const [toolCards, setToolCards] = useState<ToolCardState[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [turnStats, setTurnStats] = useState<HermesChatTurnStats | null>(null);
  const [liveSpeakerSlug, setLiveSpeakerSlug] = useState<string | null>(null);
  const [historyWindow, setHistoryWindow] = useState<HermesHistoryWindow | null>(null);
  const [contextCategories, setContextCategories] = useState<
    HermesChatContextBreakdown['categories'] | null
  >(null);

  const runningTurns = useRunningTurns();
  const isThisChatsTurn = useRef<(event: { requestId: string; sessionId?: string }) => boolean>(
    () => false
  );
  // Turns already accepted for this chat; events of one turn arrive faster than renders.
  const acceptedTurnsRef = useRef(new Set<string>());
  isThisChatsTurn.current = (event: { requestId: string; sessionId?: string }) => {
    if (acceptedTurnsRef.current.has(event.requestId) || event.requestId === activeRequestId) {
      return true;
    }
    const same = sameChat ?? ((a: string, b: string) => a === b);
    const turn = runningTurns.find((t) => t.requestId === event.requestId);
    const mine = !sessionId
      ? isOwnedRunningTurn(event.requestId)
      : Boolean(
          (event.sessionId && same(event.sessionId, sessionId)) ||
            turn?.sessionIds.some((id) => same(id, sessionId))
        );
    if (mine) acceptedTurnsRef.current.add(event.requestId);
    return mine;
  };
  // The listeners below are set up once, so they read the chat from here.
  const chatIdRef = useRef(sessionId);
  chatIdRef.current = sessionId;
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;

  // Refreshed on open and after each turn; nothing is drawn without a reported cut.
  useEffect(() => {
    setHistoryWindow(null);
    setContextCategories(null);
    if (!isDm || !sessionId || !hasMessages) return undefined;
    let live = true;
    void window.electronAPI.hermesChat
      .getContextBreakdown({ sessionId })
      .then((result) => {
        if (!live || !result.success) return;
        setHistoryWindow(result.breakdown?.history ?? null);
        setContextCategories(result.breakdown?.categories ?? null);
      })
      .catch((): void => undefined);
    return () => {
      live = false;
    };
  }, [isDm, sessionId, hasMessages]);

  useEffect(() => {
    const unsubPhase = window.electronAPI.hermesChat.onChatPhase((event) => {
      if (!isThisChatsTurn.current(event)) return;
      setPhaseEvent(event);
      if (event.usage) {
        setUsage(event.usage);
      }
      if (event.phase === 'preparing' || event.phase === 'tool' || event.phase === 'generating') {
        setActiveRequestId(event.requestId);
        if (event.phase === 'preparing') {
          setToolCards([]);
          setTurnStats(null);
          const chatId = event.sessionId ?? chatIdRef.current;
          if (chatId) clearSetupOffer(chatId, sameChatRef.current);
        }
      }
      if (event.phase === 'done' && event.sessionId) {
        void window.electronAPI.hermesChat
          .getContextBreakdown({ sessionId: event.sessionId })
          .then((result) => {
            if (!result.success || !result.breakdown) return;
            setHistoryWindow(result.breakdown.history ?? null);
            setContextCategories(result.breakdown.categories);
            setUsage((prev) => ({
              ...prev,
              contextUsed: result.breakdown!.contextUsed,
              contextMax: result.breakdown!.contextMax,
              contextPercent: result.breakdown!.contextPercent,
              contextEstimated: result.breakdown!.contextEstimated,
            }));
            // Finished cards with no paths take the context files. They show again if the
            // model restarts for an inference switch, which keeps the live turn's cards.
            const rawFilePaths = (result.breakdown.contextFiles ?? [])
              .map((f) => f.path)
              .filter(Boolean);
            const filePaths = rawFilePaths.map((p) => toHostRelativePath(p, containerPath));
            const fileProjectPaths = projectPathsOf(rawFilePaths, containerPath);
            if (filePaths.length > 0) {
              setToolCards((prev) =>
                prev.map((card) =>
                  card.status === 'done' && (!card.paths || card.paths.length === 0)
                    ? {
                        ...card,
                        paths: uniquePreserveOrder([...(card.paths ?? []), ...filePaths]),
                        projectPaths: uniquePreserveOrder([
                          ...(card.projectPaths ?? []),
                          ...fileProjectPaths,
                        ]),
                      }
                    : card
                )
              );
            }
          });
      }
    });

    const unsubTool = window.electronAPI.hermesChat.onChatTool((event) => {
      if (!isThisChatsTurn.current(event)) return;
      setActiveRequestId(event.requestId);
      const offerKind = setupOfferKind(event);
      const offerChat = event.sessionId ?? chatIdRef.current;
      if (offerKind && offerChat) {
        recordSetupOffer({ chatId: offerChat, requestId: event.requestId, kind: offerKind }, sameChatRef.current);
      }
      setToolCards((prev) => withToolEvent(prev, event, containerPath));
    });

    const unsubStats = window.electronAPI.hermesChat.onChatTurnStats((event) => {
      if (!isThisChatsTurn.current(event)) return;
      setTurnStats(event);
    });

    return () => {
      unsubPhase();
      unsubTool();
      unsubStats();
    };
  }, [containerPath]);

  useOnChatSwitch(sessionId, sameChat, () => {
    acceptedTurnsRef.current = new Set();
    setPhaseEvent(null);
    setToolCards([]);
    setTurnStats(null);
    setActiveRequestId(null);
    setLiveSpeakerSlug(null);
  });

  useEffect(() => {
    const unsub = window.electronAPI.hermesChat.onChatSpeaker((event) => {
      if (activeRequestId && event.requestId !== activeRequestId) return;
      if (!isThisChatsTurn.current(event)) return;
      setLiveSpeakerSlug(event.agentSlug);
      setActiveRequestId(event.requestId);
    });
    return () => unsub();
  }, [activeRequestId]);

  const phase: HermesChatPhase = phaseEvent?.phase ?? 'idle';
  const livePhase =
    phase === 'preparing' ||
    phase === 'restarting' ||
    phase === 'tool' ||
    phase === 'generating';

  const visibleToolCards = useMemo(() => {
    if (!livePhase || phase === 'preparing') return [];
    return activeRequestId ? toolCards.filter((c) => c.requestId === activeRequestId) : toolCards;
  }, [toolCards, activeRequestId, livePhase, phase]);

  const statsRows = useMemo(
    () =>
      phase === 'done' && turnStats
        ? formatTurnStatsLine({
            prompt: turnStats.prompt,
            generated: turnStats.generated,
            visible: turnStats.visible,
            ttftSec: turnStats.ttftSec,
          }).slice(0, 4)
        : [],
    [turnStats, phase]
  );

  const toggleToolCard = useCallback((toolId: string) => {
    setToolCards((prev) =>
      prev.map((c) => (c.toolId === toolId ? { ...c, collapsed: !c.collapsed } : c))
    );
  }, []);

  return {
    phaseEvent,
    phase,
    livePhase,
    usage,
    visibleToolCards,
    toggleToolCard,
    statsRows,
    liveSpeakerSlug,
    historyWindow,
    contextCategories,
  };
}
