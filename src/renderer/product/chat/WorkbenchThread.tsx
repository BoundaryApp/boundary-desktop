import React, { Profiler, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ComposerPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type {
  AgentDraftProposal,
  AgentProfile,
  ChannelRecord,
  HermesConversationKind,
  HermesProjectRecord,
  SessionProjectMark,
} from '../../../shared/types/hermesChat';
import { useSetupOffer } from './setupOffers';
import { ProjectPicker } from './ProjectPicker';
import { useOwnerDocument, useOwnerWindow } from '../../components/ui/ownerDocument';
import { InferenceChip } from './InferenceChip';
import { projectInferenceKey } from './projectInferenceKey';
import {
  BranchContext,
  BranchMarkAtEnd,
  BranchMarkContext,
  type BranchMarkInfo,
  type BranchRequest,
  EarlierVersionNotice,
  ProjectFilesContext,
  type ProjectFiles,
  ReplyExtrasContext,
  type ReplyExtras,
  SelectionQuote,
  RewindAllowedContext,
} from './MessageActions';
import { HtmlPreviewSheet } from './HtmlPreviewSheet';
import { projectRelativePath } from '../../../shared/hermesToolPaths';
import { FinishedTasksNote, TaskCardsContext } from './TaskCards';
import { BackgroundTurnNote, TurnNoteContext } from './TurnNotes';
import { parseMemberMentions } from '../../../shared/hermesMentions';
import { BUILTIN_AGENT_FALLBACK, builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { type DmTab } from './MentionsPane';
import { DmContextChip, DmFindBar, DmHorizonContext, DmLogHead } from './DmThreadTools';
import { horizonLabel, horizonPlacement } from './dmHorizon';
import { withQuote } from '../../../shared/markdownText';
import { displayHostPath, formatPhaseLine, sharedFallbackMarkText } from './chatTelemetryFormat';
import { ContextMeter } from './ContextMeter';
import { ThreadEmpty } from './ThreadEmpty';
import { RunButton } from './RunButton';
import { BusySendMenu } from './BusySendMenu';
import { QueueChips } from './QueueChips';
import { useRunQueueControl } from './useRunQueueControl';
import { projectMarkText } from './projectMove';
import { ProjectGlyph } from './ProjectGlyph';
import { onReactRender } from '../../debug/lagProbe';
import { formatInferenceChipTitle, inferenceMarkLabel } from '../../../shared/inferenceDisplay';
import { AssistantMessageContext, type AssistantMessageContextValue, MESSAGE_COMPONENTS } from './ThreadMessages';
import { LiveTurnView } from './LiveTurnView';
import { HeldTurnLine, type ChatLink } from './HeldTurnLine';
import {
  mergePlacedMarks,
  messageTimesKey,
  placeTranscriptMarks,
  TranscriptMarksAtEnd,
  TranscriptMarksContext,
} from './TranscriptMarks';
import { ThreadHead } from './ThreadHead';
import {
  poolMoveMarks,
  poolReplyTurns,
  PoolReplyLinesContext,
  type PoolReplyLineView,
  replyTimesKey,
} from './PoolReplyLine';
import { CONFIDENTIAL_COPY } from '../inference/confidentialCopy';
import { poolModelName, useConfidentialState } from '../inference/useConfidentialState';
import { ThreadInterrupts } from './ThreadInterrupts';
import { MentionMenu } from './MentionMenu';
import { useLiveTurn } from './useLiveTurn';
import { findRunningTurn, isOwnedRunningTurn, useRunningTurns } from './runningTurns';
import { useChatInterrupts } from './useChatInterrupts';
import { useMentionMenu } from './useMentionMenu';
import { useCommandMenu } from './useCommandMenu';
import { CommandMenu } from './CommandMenu';
import { KeptVoiceChip, MessageVoiceChip } from './WritingVoiceChips';
import { useChatWritingVoice } from './useChatWritingVoice';
import { useWritingVoiceOptions } from '../writingVoices/useWritingVoiceOptions';
import { useChatInference } from './useChatInference';
import { NO_LOCAL_MODEL_TEXT, PoolStopPrompt } from './PoolStopPrompt';
import { composerBlockFor, composerGate } from './composerGate';
import { composerSharedHint, sharedFoldersIn, useSharedFoldersOnMac } from './sharedFolderProject';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';

export interface BranchedFrom {
  parentTitle: string;
  branchedAt: string;
  seededCount: number;
  onOpenParent: () => void;
  /** Show the "Branched into a new chat · Go back" toast (right after branching). */
  justBranched?: boolean;
  onDismissToast?: () => void;
}

const BRANCH_TOAST_MS = 6000;
const NOTICE_MS = 4000;
/** Stop ignores clicks this soon after a run starts, so a double-click on Send can't stop it. */
export const STOP_GUARD_MS = 350;

interface WorkbenchThreadProps {
  sessionId: string | null;
  /** Whether two ids name the same chat (a runtime id and its stored id). */
  sameChat?: (a: string, b: string) => boolean;
  threadTitle: string;
  agent?: AgentProfile | null;
  /** Hermes chat, DM, side chat or channel (ADR 0023). Omitted reads as a DM. */
  kind?: HermesConversationKind | null;
  channel?: ChannelRecord | null;
  agents?: AgentProfile[];
  /** The conversation's own project (a DM: the folder it works in), not the rail's. */
  activeProject: HermesProjectRecord | null;
  projects: HermesProjectRecord[];
  activeProjectId: string | null;
  /**
   * ADR 0024: open Move to project… (a DM: its folder sheet). With it, a started chat's
   * project chip is fixed and the header shows project / title; without it the chip is a
   * picker, as for a chat with no messages yet.
   */
  onMoveProject?: () => void;
  /** Why Move is unavailable right now (a reply is running), or null. */
  moveDisabledReason?: string | null;
  /** The header's project crumb opens the project page. */
  onOpenProject?: () => void;
  /** Moves and DM folder changes, drawn in the transcript like inference switches. */
  projectMarks?: SessionProjectMark[];
  connecting?: boolean;
  rpcAvailable?: boolean;
  toolsEnabled: boolean;
  onToolsEnabledChange: (enabled: boolean) => void;
  /** Make channel; offered on Hermes chats only. */
  onMakeChannel?: () => void;
  /** Channels: rename the room from the title menu (ADR 0010 §3). */
  onRenameChannel?: () => void;
  /** Channels: delete the room from the title menu (ADR 0010 §3). */
  onDeleteChannel?: () => void;
  onDeleteChat?: () => void;
  /** When the conversation started, for the header's "started …" / "since …". */
  startedAt?: string | null;
  /** Hermes chats: New chat (⌘N) in the header. */
  onNewChat?: () => void;
  /** Side chats: open the agent's one ongoing DM. */
  onOpenAgentDm?: () => void;
  /** Open a kanban task's page, from a task card or a "finished" line. */
  onOpenTask?: (taskId: string) => void;
  /** Start a branch from a message; omitted in channels, where Branch is hidden. */
  onBranch?: (request: BranchRequest) => void;
  /** Set when this chat is a branch: where it came from and where its copies end. */
  branchedFrom?: BranchedFrom | null;
  /** Prompt handed back by a branch; goes in the composer once, unsent. */
  initialDraft?: string | null;
  /** Send `initialDraft` as soon as it lands (a chat started from the project page). */
  initialSend?: boolean;
  /** A quote waiting above the composer once (Mentions: Continue in DM, ADR 0023 §6). */
  initialQuote?: string | null;
  onDraftConsumed?: () => void;
  /** Mentions: Open in #room scrolls to your message with this text, once. */
  focusText?: string | null;
  /** DMs: Messages | In channels in the header (ADR 0023 §6). */
  dmTabs?: { active: DmTab; count: number; onChange: (tab: DmTab) => void } | null;
  onAddAgentToChannel?: (agent: AgentProfile) => void;
  /** Channels: adds an agent to this room; resolves true once they're a member. */
  onAddChannelMember?: (agentSlug: string) => Promise<boolean>;
  onSelectProject: (projectId: string) => void;
  onClearProject: () => void;
  onNewProject: () => void;
  onCreateAgentFromDraft?: (payload: {
    displayName: string;
    handle: string;
    role: string;
  }) => void;
  onEditAgentDraft?: (payload: AgentDraftProposal) => void;
  /** Share a message to a Circle; absent when the user is in no Circle (ADR 0042 §9). */
  onShareToCircle?: (share: { text: string; role: 'user' | 'assistant'; model?: string }) => void;
  /** Sends a reply to the inspector's Check tab; absent where no inspector shows it. */
  onCheckReply?: (check: { messageId: string; markdown: string; source: string }) => void;
  /** Sends a project file the agent wrote to the inspector's Check tab. */
  onCheckProjectFile?: (projectId: string, relativePath: string) => void;
  /** Takes the project list after the chat patches its project (Allow level B). */
  onProjectsUpdated?: (projects: HermesProjectRecord[]) => void;
  /**
   * The agent panel's layout (ADR 0058 §7): no header, since the panel draws its own; no
   * project chip; `placeholder` for the idle composer; Escape left to close the panel rather
   * than stop a reply; and prompts too wide for 384 pixels opened in the app window.
   */
  compact?: { placeholder: string; onOpenInWindow: () => void } | null;
  /** A chat's name and how to open it, for the held line's links (workload plan Phase 1a). */
  resolveChat?: (sessionId: string) => ChatLink;
}

// Stable default: a fresh `[]` per render would retrigger the mention effect forever.
const NO_AGENTS: AgentProfile[] = [];
const NO_PROJECT_MARKS: SessionProjectMark[] = [];

export const WorkbenchThread: React.FC<WorkbenchThreadProps> = ({
  sessionId,
  sameChat,
  resolveChat,
  threadTitle,
  agent = null,
  kind = null,
  channel = null,
  agents = NO_AGENTS,
  activeProject,
  projects,
  activeProjectId,
  onMoveProject,
  moveDisabledReason = null,
  onOpenProject,
  projectMarks = NO_PROJECT_MARKS,
  connecting = false,
  rpcAvailable = true,
  toolsEnabled,
  onToolsEnabledChange,
  onMakeChannel,
  onRenameChannel,
  onDeleteChannel,
  onDeleteChat,
  startedAt = null,
  onNewChat,
  onOpenAgentDm,
  onOpenTask,
  onBranch,
  branchedFrom = null,
  compact = null,
  initialDraft = null,
  initialSend = false,
  initialQuote = null,
  onDraftConsumed,
  focusText = null,
  dmTabs = null,
  onAddAgentToChannel,
  onAddChannelMember,
  onSelectProject,
  onClearProject,
  onNewProject,
  onCreateAgentFromDraft,
  onEditAgentDraft,
  onShareToCircle,
  onCheckReply,
  onCheckProjectFile,
  onProjectsUpdated,
}) => {
  // Read when Share is pressed, so the reply carries the model the chip shows then.
  const shareModelRef = useRef<string | null>(null);
  const showBranchToast = Boolean(branchedFrom?.justBranched);
  const dismissBranchToast = branchedFrom?.onDismissToast;
  useEffect(() => {
    if (!showBranchToast || !dismissBranchToast) return;
    const timer = setTimeout(dismissBranchToast, BRANCH_TOAST_MS);
    return () => clearTimeout(timer);
  }, [showBranchToast, dismissBranchToast]);

  const branchMark = useMemo<BranchMarkInfo | null>(
    () =>
      branchedFrom
        ? {
            seededCount: branchedFrom.seededCount,
            parentTitle: branchedFrom.parentTitle,
            branchedAt: branchedFrom.branchedAt,
            onOpenParent: branchedFrom.onOpenParent,
          }
        : null,
    [
      branchedFrom?.seededCount,
      branchedFrom?.parentTitle,
      branchedFrom?.branchedAt,
      branchedFrom?.onOpenParent,
    ]
  );
  const setupOffer = useSetupOffer(sessionId, sameChat);
  const [dismissedDrafts, setDismissedDrafts] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Reply extras (message-actions Phase 4): a quote waiting above the composer, and a
  // short notice for Save / Reveal outcomes.
  const [quote, setQuote] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  // Phase 7a: Search this DM. ⌘F opens it in DMs only; Esc hands focus back to the composer.
  // One kind decides every kind test (ADR 0023); an omitted kind reads as a DM.
  const conversationKind: HermesConversationKind = kind ?? 'dm';
  const isChannel = conversationKind === 'channel';
  const isDm = conversationKind === 'dm';
  // Filed conversations show project / title, with Move in the title menu (ADR 0024 §5).
  const filed = !isDm && Boolean(onOpenProject);
  const [findOpen, setFindOpen] = useState(false);
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  useEffect(() => setFindOpen(false), [sessionId]);
  useEffect(() => {
    if (!isDm) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      if (event.shiftKey || event.altKey) return;
      event.preventDefault();
      setFindOpen(false);
      // Re-mounting focuses the field even when the bar was already open.
      requestAnimationFrame(() => setFindOpen(true));
    };
    ownerWindow.addEventListener('keydown', onKey);
    return () => ownerWindow.removeEventListener('keydown', onKey);
  }, [isDm, ownerWindow]);
  const threadMessages = useAuiState((s) => s.thread.messages);
  const hasMessages = threadMessages.length > 0;
  const containerPath = activeProject?.containerPath;
  const live = useLiveTurn({ sessionId, sameChat, containerPath, isDm, hasMessages });
  const { phase, phaseEvent, usage, livePhase } = live;
  const closeFind = useCallback(() => {
    setFindOpen(false);
    inputRef.current?.focus();
  }, []);
  const onQuote = useCallback((text: string) => {
    setQuote(text);
    inputRef.current?.focus();
  }, []);
  const aui = useAui();
  // Writing voices (ADR 0056 §6): a chip on the message, or a voice kept for the chat.
  const voices = useWritingVoiceOptions();
  const chatVoice = useChatWritingVoice(sessionId, voices);
  const [voiceChip, setVoiceChip] = useState<string | null>(null);
  const voiceChipRef = useRef<string | null>(null);
  voiceChipRef.current = voiceChip;
  useEffect(() => setVoiceChip(null), [sessionId]);
  /** Before each send: the chip's voice rides in the run config once, then the chip goes. */
  const armSendVoice = useCallback(() => {
    const id = voiceChipRef.current;
    aui.composer.setRunConfig(id ? { custom: { writingVoiceId: id } } : {});
    if (id) {
      setVoiceChip(null);
      // The send reads it synchronously; after that, a Retry must not find it (it reads the
      // composer's run config).
      queueMicrotask(() => aui.composer.setRunConfig({}));
    }
  }, [aui]);

  /** Puts a waiting quote into the outgoing text; call right before a send. */
  const applyQuote = useCallback(() => {
    if (!quote) return;
    aui.composer.setText(withQuote(quote, aui.composer.getState().text));
    setQuote(null);
  }, [aui, quote]);

  /**
   * Sends now. Given `text`, that text replaces the composer's and goes out as it is (a
   * waiting quote stays for the user's own message); otherwise the composer's text goes out
   * with the quote.
   */
  const sendNow = useCallback(
    (text?: string) => {
      if (text != null) aui.composer.setText(text);
      else applyQuote();
      armSendVoice();
      aui.composer.send();
    },
    [aui, applyQuote, armSendVoice]
  );

  const [previewPath, setPreviewPath] = useState<string | null>(null);
  useEffect(() => setPreviewPath(null), [sessionId]);
  const projectFiles = useMemo<ProjectFiles>(
    () => ({
      project: activeProject,
      onNotice: setNotice,
      onCheckFile: onCheckProjectFile,
      onPreview: setPreviewPath,
    }),
    [activeProject, onCheckProjectFile]
  );
  // Reveal only for a page inside the bound project's folder.
  const previewRelative = previewPath
    ? projectRelativePath(previewPath, activeProject?.containerPath)
    : null;
  const revealPreview =
    activeProject && previewRelative
      ? () => {
          void window.electronAPI.hermesChat
            .revealProjectFile({ projectId: activeProject.id, relativePath: previewRelative })
            .then((result) => {
              if (!result.success) setNotice(result.error ?? 'Could not show the file.');
            });
        }
      : undefined;

  const replyExtras = useMemo<ReplyExtras>(
    () => ({
      onQuote,
      saveTo: activeProject
        ? {
            projectName: activeProject.name,
            onSave: (markdown: string) => {
              void window.electronAPI.hermesChat
                .saveReply({ projectId: activeProject.id, content: markdown })
                .then((result) => {
                  if (result.success && result.path) {
                    setNotice(`Saved ${result.path.split(/[\\/]/).pop()}`);
                  } else if (!result.canceled) {
                    setNotice(result.error ?? 'Could not save the reply.');
                  }
                });
            },
          }
        : undefined,
      onShare: onShareToCircle
        ? ({ text, role }) =>
            onShareToCircle({
              text,
              role,
              ...(role === 'assistant' && shareModelRef.current ? { model: shareModelRef.current } : {}),
            })
        : undefined,
      onCheck: onCheckReply,
    }),
    [onQuote, activeProject, onShareToCircle, onCheckReply]
  );

  // A branch from a prompt hands the prompt back, unsent. Once per mount: the runtime
  // for this chat is ready by the time the thread mounts.
  const draftRef = useRef({ initialDraft, initialSend, initialQuote, onDraftConsumed });
  useEffect(() => {
    const {
      initialDraft: draft,
      initialSend: sendAtOnce,
      initialQuote: handedQuote,
      onDraftConsumed: consumed,
    } = draftRef.current;
    if (!draft && !handedQuote) return;
    if (draft) aui.composer.setText(draft);
    if (handedQuote) setQuote(handedQuote);
    consumed?.();
    if (draft && sendAtOnce) {
      armSendVoice();
      aui.composer.send();
    }
  }, [aui, armSendVoice]);

  // Open in #room: once the transcript is in, bring your message into view and mark it.
  // Matched by text, newest first; if it is not found the log stays at the bottom.
  const focusRef = useRef(focusText);
  const messageCount = threadMessages.length;
  useEffect(() => {
    const target = focusRef.current?.trim();
    if (!target || messageCount === 0) return;
    focusRef.current = null;
    const rows = [...ownerDocument.querySelectorAll<HTMLElement>('.wb-log .wb-msg.is-user')].reverse();
    const hit = rows.find((el) => el.textContent?.includes(target));
    if (!hit) return;
    hit.scrollIntoView?.({ block: 'center' });
    hit.classList.add('is-focused');
    window.setTimeout(() => hit.classList.remove('is-focused'), 2400);
  }, [messageCount, ownerDocument]);
  const speakerName =
    (live.liveSpeakerSlug
      ? agents.find((a) => a.slug === live.liveSpeakerSlug)?.displayName
      : null) ??
    agent?.displayName ??
    builtinAgentName(agents);

  const interrupts = useChatInterrupts({
    sessionId,
    sameChat,
    speakerSlug: live.liveSpeakerSlug ?? agent?.slug ?? BUILTIN_AGENT_FALLBACK.slug,
  });
  const { approval, chatApprovals, credentialRequest } = interrupts;

  const memberAgents = useMemo(() => {
    if (!channel) return [];
    return agents.filter((a) => channel.memberSlugs.includes(a.slug));
  }, [agents, channel]);

  // Composer-derived values are read from the store with narrow selectors, never
  // mirrored into local state from input events: a state update inside the input
  // event re-renders the textarea with the store's previous text, which resets
  // the DOM value and throws the caret to the end.
  const addressingMembers = useAuiState(
    (s) =>
      isChannel &&
      memberAgents.length > 0 &&
      parseMemberMentions(s.composer.text, memberAgents).length > 0
  );

  const mention = useMentionMenu({
    inputRef,
    agents,
    channel,
    isChannel,
    activeProject,
    sessionId,
    onAddChannelMember,
  });

  const inference = useChatInference({
    sessionId,
    sameChat,
    send: sendNow,
    project: activeProject,
    onProjectsUpdated,
    takeNewChatWritingVoice: chatVoice.takeForNewChat,
  });
  const voiceAgent = agent ?? agents.find((a) => a.builtIn) ?? null;
  const { keep: keepChatVoice } = chatVoice;
  const command = useCommandMenu({
    voices,
    enabled: true,
    onPick: useCallback(
      (picked: { id: string }, keepIt: boolean) => {
        if (keepIt) void keepChatVoice(picked.id);
        else setVoiceChip(picked.id);
      },
      [keepChatVoice]
    ),
  });
  shareModelRef.current = inference.modelId;
  const { offlinePrompt } = inference;

  const phaseLine = formatPhaseLine({
    phase,
    elapsedSec: phaseEvent?.elapsedSec,
    toolName: phaseEvent?.toolName,
    toolTurn: phaseEvent?.toolTurn,
    maxTurns: phaseEvent?.maxTurns,
    visibleTokens: phaseEvent?.visibleTokens,
    avgTps: usage?.avgTps,
    sharedUnavailable: phaseEvent?.sharedUnavailable,
    recovery: phaseEvent?.recovery,
  });

  // Starters fill the composer for editing; they never send on their own.
  const fillComposer = useCallback(
    (text: string) => {
      aui.composer.setText(text);
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(text.length, text.length);
    },
    [aui]
  );

  const gate = composerGate(
    composerBlockFor({
      connecting,
      restarting: phase === 'restarting',
      credential: Boolean(credentialRequest),
      approval: Boolean(approval),
      offline: offlinePrompt,
      private: inference.privateRefused,
    })
  );

  /** Checks shared by Enter and the Send button; false when nothing may go out yet. */
  const prepareSend = useCallback((): boolean => {
    if (!gate.canSend) return false;
    if (!inference.checkReachable()) return false;
    applyQuote();
    return true;
  }, [applyQuote, gate.canSend, inference.checkReachable]);


  const onDismissDraft = useCallback(
    (key: string) => setDismissedDrafts((prev) => new Set(prev).add(key)),
    []
  );
  // The parent passes fresh callbacks each render; route them through refs so
  // the message context (and every rendered message) stays put.
  const draftHandlersRef = useRef({ onCreateAgentFromDraft, onEditAgentDraft });
  draftHandlersRef.current = { onCreateAgentFromDraft, onEditAgentDraft };
  const onCreateDraft = useCallback(
    (payload: { displayName: string; handle: string; role: string }) =>
      draftHandlersRef.current.onCreateAgentFromDraft?.(payload),
    []
  );
  const onEditDraft = useCallback(
    (payload: AgentDraftProposal) => draftHandlersRef.current.onEditAgentDraft?.(payload),
    []
  );
  const turnNoteContext = useMemo(() => ({ chatId: sessionId, sameChat }), [sessionId, sameChat]);

  const assistantMessageContext = useMemo<AssistantMessageContextValue>(
    () => ({
      speakerName,
      agents,
      inRoom: isChannel,
      dismissedDrafts,
      onDismissDraft,
      onCreateDraft,
      onEditDraft,
    }),
    [speakerName, agents, isChannel, dismissedDrafts, onDismissDraft, onCreateDraft, onEditDraft]
  );

  const taskCards = useMemo(
    () => ({
      sessionId,
      sameChat: sameChat ?? ((a: string, b: string) => a === b),
      agents,
      onOpenTask,
    }),
    [sessionId, sameChat, agents, onOpenTask]
  );

  // Run control (run-control spec Phase 1): one button in the input's corner sends while
  // idle and stops while a run is in flight. There is no Stop while nothing runs.
  const running = useAuiState((s) => s.thread.isRunning);
  // A turn on this chat that this screen is not streaming: started in another window, or
  // before the chat screen remounted. Stop cancels it in main by its request id.
  const chatTurn = findRunningTurn(useRunningTurns(), sessionId, sameChat);
  const backgroundRequestId =
    !running && chatTurn && !isOwnedRunningTurn(chatTurn.requestId) ? chatTurn.requestId : null;
  const stoppable = running || backgroundRequestId !== null;
  const hasDraft = useAuiState((s) => s.composer.text.trim().length > 0);
  const runStartedAtRef = useRef(0);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!running) return;
    runStartedAtRef.current = Date.now();
    setAnnouncement('');
  }, [running]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);
  const runQueue = useRunQueueControl({
    sessionId,
    sameChat,
    stoppable,
    running,
    backgroundRequestId,
    canSend: gate.canSend,
    prepareSend,
    applyQuote,
    focusInput,
    announce: setAnnouncement,
    takeVoiceChip: useCallback(() => {
      const id = voiceChipRef.current;
      setVoiceChip(null);
      return id;
    }, []),
    restoreVoiceChip: setVoiceChip,
  });
  const { pauseQueue, handleKeyDown: handleRunQueueKeyDown } = runQueue;

  const { handleMentionKeyDown } = mention;
  const { handleKeyDown: handleCommandKeyDown } = command;
  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (handleCommandKeyDown(event)) return;
      // Backspace at the very start takes the voice chip off the message.
      const box = event.currentTarget;
      if (
        event.key === 'Backspace' &&
        voiceChipRef.current &&
        box.selectionStart === 0 &&
        box.selectionEnd === 0
      ) {
        event.preventDefault();
        setVoiceChip(null);
        return;
      }
      handleMentionKeyDown(event);
      if (event.defaultPrevented) return;
      // While a reply runs, Enter asks, queues or sends now (run-control spec 2.1).
      if (handleRunQueueKeyDown(event)) return;
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      // When it passes, the composer's own Enter handler runs next and sends.
      if (!prepareSend()) event.preventDefault();
      else if (aui.composer.getState().text.trim()) armSendVoice();
    },
    [aui, armSendVoice, handleCommandKeyDown, handleMentionKeyDown, handleRunQueueKeyDown, prepareSend]
  );

  const { respondApproval, respondCredential } = interrupts;
  const stopRun = useCallback(() => {
    // A double-click on Send must not land its second click as Stop.
    if (Date.now() - runStartedAtRef.current < STOP_GUARD_MS) return;
    pauseQueue();
    if (approval?.choices.includes('deny')) void respondApproval('deny');
    if (credentialRequest) void respondCredential({});
    if (backgroundRequestId) {
      void window.electronAPI.hermesChat.cancelChat({
        requestId: backgroundRequestId,
        reason: 'stopped',
      });
    } else {
      aui.thread.cancelRun();
    }
    setAnnouncement('Response stopped');
  }, [approval, aui, backgroundRequestId, credentialRequest, pauseQueue, respondApproval, respondCredential]);

  const sendFromButton = useCallback(() => {
    if (!prepareSend()) return;
    armSendVoice();
    aui.composer.send();
    inputRef.current?.focus();
  }, [aui, armSendVoice, prepareSend]);

  // Esc stops a run from anywhere in the chat pane, but only once nothing else claims
  // it: open menus and lists close first, and a text selection's Quote popover clears.
  const onPaneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !stoppable) return;
      const pane = event.currentTarget;
      if (pane.querySelector('.wb-sel-pop')) {
        event.preventDefault();
        pane.ownerDocument.getSelection()?.removeAllRanges();
        return;
      }
      if (compact) return;
      if (pane.querySelector('[role="menu"], [role="listbox"], [role="dialog"]')) return;
      event.preventDefault();
      stopRun();
    },
    [stoppable, stopRun, compact]
  );

  const isHermesChat = conversationKind === 'hermes';
  const isSideChat = conversationKind === 'side';
  const agentName = agent?.displayName ?? builtinAgentName(agents);
  const waitingForApproval = Boolean(approval);
  const waitingForCredential = Boolean(credentialRequest);
  const composerPhase =
    connecting
      ? 'Connecting folder…'
      : !rpcAvailable && activeProject
        ? 'Folder connected · project RPC unavailable'
        : waitingForCredential
          ? 'Waiting for your answer'
        : waitingForApproval
          ? chatApprovals.length > 1
            ? `Waiting for approval · ${chatApprovals.length}`
            : 'Waiting for approval'
          : phaseLine;

  // Files written in a shared folder reach its Circle (shared folders spec, decision 8).
  const sharedFolders = useSharedFoldersOnMac();
  const sharedHint = activeProject ? composerSharedHint(sharedFoldersIn(activeProject.hostPath, sharedFolders)) : null;
  const composerPlaceholder =
    gate.placeholder ??
    (stoppable
      ? runQueue.alwaysQueue
        ? 'Enter queues · ⌘↵ sends now'
        : 'Draft your next message… Enter asks what to do with it'
      : isHermesChat
          ? (compact?.placeholder ?? `Ask ${agentName} anything`)
          : isSideChat
            ? `Message ${agentName} · side chat`
          : isChannel
            ? addressingMembers
              ? `Address #${channel?.slug ?? 'channel'} · Enter wakes mentioned members`
              : `Post to #${channel?.slug ?? 'channel'} · @ to address someone now`
            : `Message ${speakerName}…`);

  const horizon = useMemo(() => {
    if (!isDm) return null;
    const placed = horizonPlacement(live.historyWindow, threadMessages);
    return placed ? { index: placed.index, label: horizonLabel(agentName, placed.window) } : null;
  }, [isDm, live.historyWindow, threadMessages, agentName]);
  const contextBudget = isDm ? live.historyWindow?.budget ?? null : null;

  const { inferenceMarks, poolTurns, turnWindows } = inference;
  const messageTimes = useAuiState((s) => messageTimesKey(s.thread.messages));
  const replyTimes = useAuiState((s) => replyTimesKey(s.thread.messages));
  const { state: confidential } = useConfidentialState();
  // Which provider wrote each reply a pool answered, and where the chat moved (spec decision 9).
  const poolOwners = useMemo(
    () => poolReplyTurns(poolTurns, turnWindows, replyTimes),
    [poolTurns, turnWindows, replyTimes]
  );
  const poolLines = useMemo(() => {
    const lines = new Map<string, PoolReplyLineView>();
    for (const [id, turn] of poolOwners) {
      lines.set(id, {
        text: CONFIDENTIAL_COPY.servedBy(poolModelName(confidential, turn.modelId), turn.providerName),
        level: turn.level,
      });
    }
    return lines;
  }, [poolOwners, confidential]);
  const placedMarks = useMemo(
    () =>
      placeTranscriptMarks(
        [
          ...projectMarks.map((mark) => ({
            id: mark.id,
            at: mark.at,
            text: projectMarkText(mark, projects, agentName),
            className: 'wb-switch-mark wb-project-mark',
          })),
          ...inferenceMarks.map((mark) => ({
            id: mark.id,
            at: mark.at,
            text:
              mark.kind === 'recovered'
                ? `Back on ${inferenceMarkLabel(mark)}`
                : mark.provider === 'peer'
                  ? sharedFallbackMarkText(mark)
                  : mark.kind === 'fell-back'
                    ? `Using ${formatInferenceChipTitle(mark.provider, mark.modelId)} from here, a fallback`
                    : `Switched to ${formatInferenceChipTitle(mark.provider, mark.modelId)}`,
            className: `wb-switch-mark wb-model-mark${mark.kind === 'fell-back' ? ' is-fallback' : ''}`,
          })),
          ...chatVoice.marks.map((mark) => ({
            id: mark.id,
            at: mark.at,
            text:
              mark.kind === 'kept' && mark.voiceName
                ? `Writing in ${mark.voiceName} from here`
                : `Back to ${agentName}'s voice from here`,
            className: 'wb-switch-mark wb-voice-mark',
          })),
        ],
        messageTimes
      ),
    [projectMarks, inferenceMarks, chatVoice.marks, projects, agentName, messageTimes]
  );
  const transcriptMarks = useMemo(
    () =>
      mergePlacedMarks(
        placedMarks,
        poolMoveMarks(poolOwners, replyTimes, (turn) => CONFIDENTIAL_COPY.tookOver(turn.providerName, turn.moved))
      ),
    [placedMarks, poolOwners, replyTimes]
  );

  return (
    <ThreadPrimitive.Root
      className="relative flex h-full min-h-0 flex-col"
      onKeyDown={onPaneKeyDown}
    >
      {compact ? null : <ThreadHead
        kind={conversationKind}
        threadTitle={threadTitle}
        agent={agent}
        agents={agents}
        channel={channel}
        startedAt={startedAt}
        activeProject={activeProject}
        filed={filed}
        branchedFrom={branchedFrom}
        onOpenProject={onOpenProject}
        onMoveProject={onMoveProject}
        moveDisabledReason={moveDisabledReason}
        onMakeChannel={onMakeChannel}
        onRenameChannel={onRenameChannel}
        onDeleteChannel={onDeleteChannel}
        onDeleteChat={onDeleteChat}
        onNewChat={onNewChat}
        onOpenAgentDm={onOpenAgentDm}
        onAddAgentToChannel={onAddAgentToChannel}
        dmTabs={dmTabs}
      />}

      {isDm && findOpen ? <DmFindBar onClose={closeFind} /> : null}

      <HtmlPreviewSheet
        containerPath={previewPath}
        onClose={() => setPreviewPath(null)}
        reveal={revealPreview}
      />

      {notice && !showBranchToast ? (
        <div className="wb-toast" role="status">
          {notice}
        </div>
      ) : null}

      {showBranchToast && branchedFrom ? (
        <div className="wb-toast" role="status">
          Branched into a new chat
          <button type="button" onClick={branchedFrom.onOpenParent}>
            Go back
          </button>
        </div>
      ) : null}

      <ContextMeter usage={usage} categories={live.contextCategories} />

      <TurnNoteContext.Provider value={turnNoteContext}>
      <TranscriptMarksContext.Provider value={transcriptMarks}>
      <PoolReplyLinesContext.Provider value={poolLines}>
      <ThreadPrimitive.Viewport className="wb-log" role="log" aria-label="Transcript">
        <ThreadPrimitive.Empty>
          <ThreadEmpty
            connecting={connecting}
            channelSlug={isChannel ? channel?.slug ?? 'channel' : null}
            project={activeProject}
            onStarter={fillComposer}
          />
        </ThreadPrimitive.Empty>

        {isDm ? <DmLogHead startedAt={startedAt} onSearch={() => setFindOpen(true)} /> : null}

        <TaskCardsContext.Provider value={taskCards}>
        <DmHorizonContext.Provider value={horizon}>
        <AssistantMessageContext.Provider value={assistantMessageContext}>
          {/* Channel posts live in Boundary's overlay, not the Hermes transcript (spec Phase 2). */}
          <RewindAllowedContext.Provider value={!isChannel}>
            <BranchContext.Provider value={isChannel ? null : (onBranch ?? null)}>
              <BranchMarkContext.Provider value={branchMark}>
                <ReplyExtrasContext.Provider value={replyExtras}>
                  <ProjectFilesContext.Provider value={projectFiles}>
                    <Profiler id="thread:messages" onRender={onReactRender}>
                      <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
                    </Profiler>
                  </ProjectFilesContext.Provider>
                </ReplyExtrasContext.Provider>
                <BranchMarkAtEnd />
              </BranchMarkContext.Provider>
            </BranchContext.Provider>
          </RewindAllowedContext.Provider>
        </AssistantMessageContext.Provider>
        </DmHorizonContext.Provider>

        <FinishedTasksNote />
        </TaskCardsContext.Provider>

        <BackgroundTurnNote speakerName={speakerName} />

        <TranscriptMarksAtEnd />

        <LiveTurnView
          phase={phase}
          phaseLine={phaseLine}
          toolCards={live.visibleToolCards}
          onToggleTool={live.toggleToolCard}
          project={activeProject}
          onNotice={setNotice}
          setupOfferChatId={setupOffer?.chatId ?? null}
          statsRows={live.statsRows}
          heldLine={
            phaseEvent?.held ? (
              <HeldTurnLine
                held={phaseEvent.held}
                resolveChat={resolveChat}
                onRunNow={() => {
                  void window.electronAPI.hermesChat.runHeldTurnNow({ requestId: phaseEvent.requestId });
                }}
              />
            ) : null
          }
        />
      </ThreadPrimitive.Viewport>
      </PoolReplyLinesContext.Provider>
      </TranscriptMarksContext.Provider>
      </TurnNoteContext.Provider>

      <ThreadInterrupts
        interrupts={interrupts}
        projects={projects}
        onFollowUp={sendNow}
        onOpenInWindow={compact?.onOpenInWindow}
      />

      <div
        className={`wb-composer${gate.inputLocked ? ' is-locked' : ''}`}
      >
        {command.showing ? (
          <CommandMenu
            query={command.query}
            items={command.items}
            index={command.index}
            agentVoiceId={voiceAgent?.chatRepliesVoiceId ?? null}
            agentName={agentName}
            onPick={command.pick}
          />
        ) : mention.showing ? (
          <MentionMenu items={mention.items} index={mention.index} onPick={mention.insertMention} />
        ) : null}

        <SelectionQuote onQuote={onQuote} onCheck={onCheckReply} />
        <Profiler id="thread:composer" onRender={onReactRender}>
          <ComposerPrimitive.Root>
            <EarlierVersionNotice />
            {quote ? (
              <div className="wb-quote">
                <p>{quote}</p>
                <button
                  type="button"
                  className="wb-act"
                  aria-label="Remove quote"
                  onClick={() => setQuote(null)}
                >
                  ×
                </button>
              </div>
            ) : null}
            {offlinePrompt ? (
              <div className="wb-offline-prompt">
                <p>Local model unreachable. Retry, or send this message via OpenRouter?</p>
                <div className="wb-offline-actions">
                  <Button variant="secondary" size="sm" type="button" onClick={() => void inference.retryLocal()}>
                    Retry local
                  </Button>
                  {inference.openRouterConfigured ? (
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() => void inference.sendViaOpenRouter()}
                    >
                      Send via OpenRouter
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {inference.privateRefused && inference.poolStop ? (
              <PoolStopPrompt
                stop={inference.poolStop}
                localModelId={inference.localModelId}
                onAllowLevelB={inference.allowLevelB ? () => void inference.allowLevelB?.() : undefined}
                onUseLocal={() => void inference.sendViaLocal()}
                busy={inference.allowingLevelB}
                error={inference.allowLevelBError}
              />
            ) : inference.privateRefused ? (
              <div className="wb-offline-prompt" role="alert">
                <p>
                  This project is private and this chat’s model isn’t, so nothing can be sent.{' '}
                  {inference.localModelId
                    ? 'Use your local model here, or pin one for the project.'
                    : NO_LOCAL_MODEL_TEXT}
                </p>
                {inference.localModelId ? (
                  <div className="wb-offline-actions">
                    <Button
                      variant="primary"
                      size="sm"
                      type="button"
                      onClick={() => void inference.sendViaLocal()}
                    >
                      Send with {formatInferenceChipTitle('local', inference.localModelId)}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <QueueChips {...runQueue.chips} />
            <div className="wb-input-box">
              {runQueue.menuIndex !== null ? (
                <BusySendMenu
                  agentName={speakerName}
                  activeIndex={runQueue.menuIndex}
                  alwaysQueue={runQueue.alwaysQueue}
                  onPick={runQueue.pick}
                  onAlwaysQueueChange={runQueue.setAlwaysQueue}
                />
              ) : null}
              {voiceChip ? (
                <MessageVoiceChip
                  name={voices.find((v) => v.id === voiceChip)?.name ?? voiceChip}
                  onKeep={() => {
                    void keepChatVoice(voiceChip);
                    setVoiceChip(null);
                  }}
                  onRemove={() => setVoiceChip(null)}
                />
              ) : null}
              <ComposerPrimitive.Input
                ref={inputRef as never}
                rows={2}
                placeholder={composerPlaceholder}
                disabled={gate.inputLocked}
                // The pane owns Esc (onPaneKeyDown): open lists close first, and the
                // double-click guard applies. The input's own Esc-cancel skips both.
                cancelOnEscape={false}
                onKeyDown={handleComposerKeyDown}
                title={mention.showing ? 'Enter to select mention · Esc to dismiss' : gate.title}
              />
              {stoppable || !gate.hideIdleRunButton ? (
                <RunButton
                  running={stoppable}
                  held={Boolean(approval || credentialRequest)}
                  canSend={hasDraft && gate.canSend}
                  onSend={sendFromButton}
                  onStop={stopRun}
                />
              ) : null}
            </div>
            <div className="wb-cluster">
              {compact ? null : onMoveProject && (isDm || messageCount > 0) ? (
                <button
                  type="button"
                  className="wb-chip"
                  disabled={connecting || Boolean(moveDisabledReason)}
                  title={
                    moveDisabledReason ??
                    (isDm
                      ? `The folder ${agentName} works in. Changes are marked in the thread.`
                      : `This chat lives in ${activeProject?.name ?? 'No project'}. Move it to work in another folder.`)
                  }
                  onClick={onMoveProject}
                >
                  {isDm ? <span className="wb-chip-prefix">Works in</span> : null}
                  <ProjectGlyph project={activeProject} inline size={12} />
                  {activeProject ? (
                    <>
                      <b>{activeProject.name}</b>
                      <span className="mono">{displayHostPath(activeProject.hostPath)}</span>
                    </>
                  ) : (
                    'No project'
                  )}
                </button>
              ) : (
                <ProjectPicker
                  variant="chip"
                  projects={projects}
                  activeProjectId={activeProjectId}
                  connecting={connecting || Boolean(moveDisabledReason)}
                  triggerLabel="Where this chat lives"
                  menuTitle="Start this chat in"
                  onSelectProject={onSelectProject}
                  onClearProject={onClearProject}
                  onNewProject={onNewProject}
                />
              )}
              <InferenceChip
                sessionId={sessionId}
                disabled={gate.block === 'connecting' || gate.block === 'restarting'}
                applying={phase === 'restarting'}
                projectInferenceKey={projectInferenceKey(activeProject)}
                resolved={inference.resolved}
                marks={inference.inferenceMarks}
                poolTurns={inference.poolTurns}
                refresh={inference.refresh}
              />
              {chatVoice.voiceId && chatVoice.voiceName ? (
                <KeptVoiceChip
                  name={chatVoice.voiceName}
                  voiceId={chatVoice.voiceId}
                  voices={voices}
                  agentName={agentName}
                  onKeep={(id) => void keepChatVoice(id)}
                />
              ) : null}
              {contextBudget != null ? (
                <DmContextChip budget={contextBudget} agentName={agentName} />
              ) : null}
              <button
                type="button"
                className="wb-chip"
                disabled={connecting}
                onClick={mention.openFromChip}
              >
                @
              </button>
              {composerPhase ? (
                <span
                  className={`wb-phase-slot${livePhase || waitingForApproval ? ' is-live' : ''}`}
                  title={typeof composerPhase === 'string' ? composerPhase : undefined}
                >
                  {composerPhase}
                </span>
              ) : null}
              <label className="wb-toggle">
                Tools
                <Switch checked={toolsEnabled} onChange={onToolsEnabledChange} />
              </label>
            </div>
            {sharedHint ? <p className="wb-composer-shared">{sharedHint}</p> : null}
          </ComposerPrimitive.Root>
        </Profiler>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </ThreadPrimitive.Root>
  );
};
