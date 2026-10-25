import React, {
  Profiler,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isOwnedRunningTurn, useRunningTurns } from './runningTurns';
import {
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import { useAui, useAuiState } from '@assistant-ui/store';
import { Streamdown } from 'streamdown';
import type {
  AgentDraftProposal,
  AgentProfile,
  ChannelRecord,
  HermesApprovalChoice,
  HermesChatApprovalEvent,
  HermesChatContextBreakdown,
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
  HermesChatPhase,
  HermesChatPhaseEvent,
  HermesChatToolEvent,
  HermesChatTurnStats,
  HermesChatUsageSnapshot,
  HermesCompletePathItem,
  HermesHistoryWindow,
  HermesProjectRecord,
} from '../../../shared/types/hermesChat';
import {
  formatToolCardMeta,
  formatTurnStatsLine,
  projectRelativePath,
  toHostRelativePath,
  uniquePreserveOrder,
} from '../../../shared/hermesToolPaths';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { onboardingIPC } from '../../services/onboardingIPCService';
import { ApprovalInterrupt } from './ApprovalInterrupt';
import { HostBridgeApproval } from './HostBridgeApproval';
import { useHostBridgeApprovals } from './useHostBridgeApprovals';
import { useHostToolsState } from './useHostToolsState';
import { useCodingAccessRequests } from './useCodingAccessRequests';
import { CodingAccessInterrupt } from './CodingAccessInterrupt';
import { SetupOfferCard } from './SetupOfferCard';
import { clearSetupOffer, recordSetupOffer, setupOfferKind, useSetupOffer } from './setupOffers';
import { CredentialInterrupt } from './CredentialInterrupt';
import { openSettings } from '../settingsNavigation';
import { ProjectPicker } from './ProjectPicker';
import { InferenceChip } from './InferenceChip';
import {
  AssistantMessageActions,
  BranchContext,
  BranchMarkAtEnd,
  BranchMarkBefore,
  BranchMarkContext,
  type BranchMarkInfo,
  type BranchRequest,
  DayDivider,
  EarlierVersionNotice,
  FileActions,
  ProjectFilesContext,
  type ProjectFiles,
  ReplyExtrasContext,
  ReplyEnding,
  ReplyFiles,
  type ReplyExtras,
  SelectionQuote,
  RewindAllowedContext,
  UserEditComposer,
  UserMessageActions,
} from './MessageActions';
import { FiledTaskCards, FinishedTasksNote, TaskCardsContext } from './TaskCards';
import {
  BackgroundTurnNote,
  LiveNoReplyNote,
  TurnNoteContext,
  UnansweredNote,
} from './TurnNotes';
import { useInferenceSendHandlers } from './HermesChatRuntimeProvider';
import { parseMemberMentions } from '../../../shared/hermesMentions';
import { BUILTIN_AGENT_FALLBACK, builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { formatChannelHead } from './channelHead';
import { ConversationMark } from './ConversationMark';
import { DmTabs, type DmTab } from './MentionsPane';
import {
  DmContextChip,
  DmFindBar,
  DmHorizonContext,
  DmHorizonMark,
  DmLogHead,
  useBeyondHorizon,
} from './DmThreadTools';
import { horizonLabel, horizonPlacement } from './dmHorizon';
import { headKindLine } from './conversationKinds';
import { parseAgentDraft, stripAgentDraftFence } from './agentDraft';
import { speakerSegmentsOf, type SpeakerSegment } from './speakerSegments';
import {
  escapeUnknownTags,
  splitLeadingQuote,
  withQuote,
} from '../../../shared/markdownText';
import {
  displayHostPath,
  formatContextGauge,
  splitContextBar,
  formatPhaseLine,
  projectGlyph,
  projectGlyphColor,
} from './chatTelemetryFormat';
import { projectMarkText } from './projectMove';
import { onReactRender } from '../../debug/lagProbe';
import { InfoTip } from '../../components/ui/info-tip';
import { formatInferenceChipTitle, inferenceSlotLabel } from '../../../shared/inferenceDisplay';
import type {
  HermesConversationKind,
  ResolvedSessionInference,
  SessionInferenceMark,
  SessionProjectMark,
} from '../../../shared/types/hermesChat';

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
  isChannel?: boolean;
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
}

type ToolCardState = HermesChatToolEvent & {
  collapsed?: boolean;
  /** Paths inside the active project's mount, relative to it: these can be revealed. */
  projectPaths?: string[];
};

type MentionItem =
  | (HermesCompletePathItem & { kind: 'file' })
  | {
      kind: 'agent';
      text: string;
      display: string;
      meta: string;
      agentSlug: string;
      notInChannel?: boolean;
    };

/** Text after the last `@` that starts a word, or null when no mention is being typed. */
function mentionQueryFor(text: string): string | null {
  const at = text.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(text[at - 1] ?? ''))) return null;
  return text.slice(at + 1);
}

interface AssistantMessageContextValue {
  speakerName: string;
  /** For naming a reply's own speaker (rooms record one per turn). */
  agents: AgentProfile[];
  /** In a room every speaker line carries its mark, since several agents speak. */
  inRoom: boolean;
  dismissedDrafts: Set<string>;
  onDismissDraft: (key: string) => void;
  onCreateDraft?: (payload: { displayName: string; handle: string; role: string }) => void;
  onEditDraft?: (payload: AgentDraftProposal) => void;
}

const AssistantMessageContext = createContext<AssistantMessageContextValue>({
  speakerName: BUILTIN_AGENT_FALLBACK.displayName,
  agents: [],
  inRoom: false,
  dismissedDrafts: new Set(),
  onDismissDraft: () => undefined,
});

// Stable default: a fresh `[]` per render would retrigger the mention effect forever.
const NO_AGENTS: AgentProfile[] = [];
const NO_PROJECT_MARKS: SessionProjectMark[] = [];

function ProjectGlyph({ project, size = 14 }: { project: HermesProjectRecord | null; size?: number }) {
  return project ? (
    <span
      className="wb-glyph wb-glyph-inline"
      style={{ background: projectGlyphColor(project.id), width: size, height: size }}
      aria-hidden="true"
    >
      {projectGlyph(project.name)}
    </span>
  ) : (
    <span
      className="wb-glyph wb-glyph-inline is-none"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      –
    </span>
  );
}

const PROJECT_STARTERS = [
  'Summarize what’s in this folder',
  'What changed here most recently?',
  'Draft a README for this project',
];

const GENERAL_STARTERS = [
  'Plan my week from a list of tasks',
  'Draft a short email asking to meet next week',
  'Explain how projects and sources work in Boundary',
];

export const WorkbenchThread: React.FC<WorkbenchThreadProps> = ({
  sessionId,
  sameChat,
  threadTitle,
  agent = null,
  kind = null,
  isChannel = false,
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
  startedAt = null,
  onNewChat,
  onOpenAgentDm,
  onOpenTask,
  onBranch,
  branchedFrom = null,
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
}) => {
  const [phaseEvent, setPhaseEvent] = useState<HermesChatPhaseEvent | null>(null);

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
  const [usage, setUsage] = useState<HermesChatUsageSnapshot | null>(null);
  const [toolCards, setToolCards] = useState<ToolCardState[]>([]);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  // Phase events come for every running turn; this chat shows only its own (another chat's
  // "Preparing…" here would look like the reply is coming to this chat).
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
  const [turnStats, setTurnStats] = useState<HermesChatTurnStats | null>(null);
  const [approvals, setApprovals] = useState<HermesChatApprovalEvent[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const hostApprovals = useHostBridgeApprovals();
  const hostTools = useHostToolsState();
  const codingAccess = useCodingAccessRequests(sessionId, sameChat);
  const setupOffer = useSetupOffer(sessionId, sameChat);
  // The phase and tool listeners below are set up once, so they read the chat from here.
  const chatIdRef = useRef(sessionId);
  chatIdRef.current = sessionId;
  const sameChatRef = useRef(sameChat);
  sameChatRef.current = sameChat;
  const [credentialRequests, setCredentialRequests] = useState<HermesChatCredentialRequestEvent[]>([]);
  // After a login is saved from chat: where it went, with a way to manage it.
  const [savedLogin, setSavedLogin] = useState<{ site: string; agentSlug: string } | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [liveSpeakerSlug, setLiveSpeakerSlug] = useState<string | null>(null);
  const [dismissedDrafts, setDismissedDrafts] = useState<Set<string>>(new Set());
  const [inferenceMarks, setInferenceMarks] = useState<SessionInferenceMark[]>([]);
  const [resolvedInference, setResolvedInference] = useState<ResolvedSessionInference | null>(
    null
  );
  const [offlinePrompt, setOfflinePrompt] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [openRouterConfigured, setOpenRouterConfigured] = useState(false);
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
  const isDm = !isChannel && (kind ?? 'dm') === 'dm';
  // Filed conversations show project / title, with Move in the title menu (ADR 0024 §5).
  const filed = !isDm && Boolean(onOpenProject);
  const [titleMenuOpen, setTitleMenuOpen] = useState(false);
  useEffect(() => {
    if (!titleMenuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && (event.target as Element).closest?.('.wb-title-menu')) {
        return;
      }
      setTitleMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [titleMenuOpen]);
  const [findOpen, setFindOpen] = useState(false);
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDm]);
  // Phase 7b: the DM's context horizon, as the stack reports it (CR 0002 R2). Refreshed
  // on open and after each turn; nothing is drawn without a reported cut.
  const [historyWindow, setHistoryWindow] = useState<HermesHistoryWindow | null>(null);
  // What fills the context window now (system / tools vs conversation), for the meter split.
  const [contextCategories, setContextCategories] = useState<
    HermesChatContextBreakdown['categories'] | null
  >(null);
  const threadMessages = useAuiState((s) => s.thread.messages);
  const hasMessages = threadMessages.length > 0;
  useEffect(() => {
    setHistoryWindow(null);
    setContextCategories(null);
    if (!isDm || !sessionId || !hasMessages) return undefined;
    let live = true;
    void hermesChatIPC
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
  const closeFind = useCallback(() => {
    setFindOpen(false);
    inputRef.current?.focus();
  }, []);
  const onQuote = useCallback((text: string) => {
    setQuote(text);
    inputRef.current?.focus();
  }, []);
  const aui = useAui();

  /** Puts a waiting quote into the outgoing text; call right before a send. */
  const applyQuote = useCallback(() => {
    if (!quote) return;
    aui.composer.setText(withQuote(quote, aui.composer.getState().text));
    setQuote(null);
  }, [aui, quote]);

  const projectFiles = useMemo<ProjectFiles>(
    () => ({ project: activeProject, onNotice: setNotice }),
    [activeProject]
  );

  const replyExtras = useMemo<ReplyExtras>(
    () => ({
      onQuote,
      saveTo: activeProject
        ? {
            projectName: activeProject.name,
            onSave: (markdown: string) => {
              void hermesChatIPC
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
    }),
    [onQuote, activeProject]
  );

  // A branch from a prompt hands the prompt back, unsent. Once per mount: the runtime
  // for this chat is ready by the time the thread mounts.
  const draftRef = useRef({ initialDraft, initialSend, initialQuote, onDraftConsumed });
  useEffect(() => {
    const {
      initialDraft: draft,
      initialSend: sendNow,
      initialQuote: handedQuote,
      onDraftConsumed: consumed,
    } = draftRef.current;
    if (!draft && !handedQuote) return;
    if (draft) aui.composer.setText(draft);
    if (handedQuote) setQuote(handedQuote);
    consumed?.();
    if (draft && sendNow) (aui.composer as { send?: () => void }).send?.();
  }, [aui]);

  // Open in #room: once the transcript is in, bring your message into view and mark it.
  // Matched by text, newest first; if it is not found the log stays at the bottom.
  const focusRef = useRef(focusText);
  const messageCount = useAuiState((s) => s.thread.messages.length);
  useEffect(() => {
    const target = focusRef.current?.trim();
    if (!target || messageCount === 0) return;
    focusRef.current = null;
    const rows = [...document.querySelectorAll<HTMLElement>('.wb-log .wb-msg.is-user')].reverse();
    const hit = rows.find((el) => el.textContent?.includes(target));
    if (!hit) return;
    hit.scrollIntoView?.({ block: 'center' });
    hit.classList.add('is-focused');
    window.setTimeout(() => hit.classList.remove('is-focused'), 2400);
  }, [messageCount]);
  const ackedApprovalRef = useRef<string | null>(null);
  const containerPath = activeProject?.containerPath;
  const speakerName =
    (liveSpeakerSlug
      ? agents.find((a) => a.slug === liveSpeakerSlug)?.displayName
      : null) ??
    agent?.displayName ??
    builtinAgentName(agents);

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
  const typedMentionQuery = useAuiState((s) => mentionQueryFor(s.composer.text));

  useEffect(() => {
    setMentionOpen(typedMentionQuery !== null);
    setMentionQuery(typedMentionQuery ?? '');
  }, [typedMentionQuery]);

  useEffect(() => {
    const unsubPhase = hermesChatIPC.onChatPhase((event) => {
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
        void hermesChatIPC
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

    const unsubTool = hermesChatIPC.onChatTool((event) => {
      if (!isThisChatsTurn.current(event)) return;
      setActiveRequestId(event.requestId);
      const offerKind = setupOfferKind(event);
      const offerChat = event.sessionId ?? chatIdRef.current;
      if (offerKind && offerChat) {
        recordSetupOffer({ chatId: offerChat, requestId: event.requestId, kind: offerKind }, sameChatRef.current);
      }
      setToolCards((prev) => {
        const idx = prev.findIndex((c) => c.toolId === event.toolId);
        const relativePaths = (event.paths ?? []).map((p) =>
          toHostRelativePath(p, containerPath)
        );
        const next: ToolCardState = {
          ...event,
          paths: uniquePreserveOrder(relativePaths),
          projectPaths: projectPathsOf(event.paths ?? [], containerPath),
          collapsed: event.status === 'done',
        };
        if (idx >= 0) {
          const merged = [...prev];
          const existing = merged[idx]!;
          merged[idx] = {
            ...existing,
            ...next,
            paths: uniquePreserveOrder([
              ...(existing.paths ?? []),
              ...(next.paths ?? []),
            ]),
            collapsed:
              event.status === 'done' ? true : (existing.collapsed ?? false),
          };
          return merged;
        }
        return [...prev, next];
      });
    });

    const unsubApproval = hermesChatIPC.onChatApproval((event) => {
      setApprovals((prev) => {
        if (prev.some((item) => item.rpcRequestId === event.rpcRequestId)) {
          return prev.map((item) =>
            item.rpcRequestId === event.rpcRequestId ? event : item
          );
        }
        return [...prev, event];
      });
    });

    const unsubCredential = hermesChatIPC.onChatCredentialRequest((event) => {
      setCredentialRequests((prev) =>
        prev.some((item) => item.rpcRequestId === event.rpcRequestId)
          ? prev.map((item) => (item.rpcRequestId === event.rpcRequestId ? event : item))
          : [...prev, event]
      );
    });

    const unsubStats = hermesChatIPC.onChatTurnStats((event) => {
      if (!isThisChatsTurn.current(event)) return;
      setTurnStats(event);
    });

    return () => {
      unsubPhase();
      unsubTool();
      unsubApproval();
      unsubCredential();
      unsubStats();
    };
  }, [containerPath]);

  // A switch to another chat clears the live turn; the open chat getting its real session id
  // (a DM placeholder's first send) is the same chat, so its turn stays.
  const shownChatRef = useRef(sessionId);
  useEffect(() => {
    const prev = shownChatRef.current;
    shownChatRef.current = sessionId;
    if (prev && sessionId && prev !== sessionId && sameChat?.(prev, sessionId)) return;
    acceptedTurnsRef.current = new Set();
    setPhaseEvent(null);
    setToolCards([]);
    setTurnStats(null);
    setApprovals([]);
    setCredentialError(null);
    setActiveRequestId(null);
    setLiveSpeakerSlug(null);
  }, [sessionId]);

  // A credential prompt blocks the agent until answered, so it outlives a chat switch:
  // main keeps it parked, and each mount or switch shows whatever is still waiting.
  useEffect(() => {
    let cancelled = false;
    void hermesChatIPC
      .listPendingCredentialRequests()
      .then((pending) => {
        if (!cancelled) setCredentialRequests(pending);
      })
      .catch(() => {
        /* best effort: live events still arrive */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const unsub = hermesChatIPC.onChatSpeaker((event) => {
      if (activeRequestId && event.requestId !== activeRequestId) return;
      setLiveSpeakerSlug(event.agentSlug);
      setActiveRequestId(event.requestId);
    });
    return () => unsub();
  }, [activeRequestId]);

  useEffect(() => {
    if (!mentionOpen) {
      setMentionItems([]);
      setMentionIndex(0);
      return;
    }
    let cancelled = false;
    const q = mentionQuery.trim().toLowerCase();

    const matchesQuery = (a: AgentProfile) => {
      if (!q) return true;
      return (
        a.displayName.toLowerCase().includes(q) ||
        a.handle.toLowerCase().includes(q) ||
        a.slug.toLowerCase().includes(q)
      );
    };

    let agentHits: MentionItem[] = [];
    if (isChannel && channel) {
      const members = agents.filter(
        (a) => channel.memberSlugs.includes(a.slug) && matchesQuery(a)
      );
      const nonMembers = agents.filter(
        (a) => !channel.memberSlugs.includes(a.slug) && matchesQuery(a)
      );
      agentHits = [
        ...members.slice(0, 6).map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn ? 'Default agent · member · address now' : 'Member · address now',
          agentSlug: a.slug,
        })),
        ...nonMembers.slice(0, 4).map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn
            ? 'Default agent · not in channel · add to let it read'
            : 'Not in channel · add to let them read',
          agentSlug: a.slug,
          notInChannel: true,
        })),
      ];
    } else {
      agentHits = agents
        .filter(matchesQuery)
        .slice(0, 6)
        .map((a) => ({
          kind: 'agent' as const,
          text: a.displayName,
          display: a.displayName,
          meta: a.builtIn ? 'Default agent' : a.role,
          agentSlug: a.slug,
        }));
    }

    if (!activeProject) {
      setMentionItems(agentHits);
      setMentionIndex(0);
      return;
    }

    const handle = window.setTimeout(() => {
      void hermesChatIPC
        .completePath({
          word: mentionQuery,
          cwd: activeProject.containerPath,
          sessionId: sessionId ?? undefined,
        })
        .then((result) => {
          if (cancelled) return;
          const files: MentionItem[] = (result.success ? result.items : [])
            .slice(0, 8)
            .map((item) => ({
              ...item,
              kind: 'file' as const,
            }));
          setMentionItems([...agentHits, ...files]);
          setMentionIndex(0);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mentionOpen, mentionQuery, activeProject, sessionId, agents, isChannel, channel]);

  useInferenceSendHandlers({
    onLocalUnreachable: () => {
      setOfflinePrompt(true);
      setApplyError(null);
    },
    onApplyFailed: (error) => {
      setApplyError(error);
      setOfflinePrompt(false);
    },
  });

  useEffect(() => {
    if (!offlinePrompt) return;
    void onboardingIPC.getStatus().then((status) => {
      setOpenRouterConfigured(Boolean(status.slots.openrouter?.configured && status.slots.openrouter.modelId));
    });
  }, [offlinePrompt]);

  useEffect(() => {
    if (resolvedInference?.slot === 'local' && resolvedInference.health === 'unreachable') {
      return;
    }
    if (resolvedInference?.slot !== 'local') {
      setOfflinePrompt(false);
    }
  }, [resolvedInference]);

  const gauge = useMemo(() => formatContextGauge(usage), [usage]);
  const phase: HermesChatPhase = phaseEvent?.phase ?? 'idle';
  const phaseLine = formatPhaseLine({
    phase,
    elapsedSec: phaseEvent?.elapsedSec,
    toolName: phaseEvent?.toolName,
    toolTurn: phaseEvent?.toolTurn,
    maxTurns: phaseEvent?.maxTurns,
    visibleTokens: phaseEvent?.visibleTokens,
    avgTps: usage?.avgTps,
  });

  // usage.prompt / usage.completion are session-lifetime totals (every API call re-sends the
  // window), so they can't size a share of the window; the breakdown's categories can.
  const barSplit = useMemo(
    () => splitContextBar(gauge.percent, contextCategories),
    [gauge.percent, contextCategories]
  );

  const livePhase =
    phase === 'preparing' ||
    phase === 'restarting' ||
    phase === 'tool' ||
    phase === 'generating';

  const visibleToolCards = useMemo(
    () => {
      if (!livePhase || phase === 'preparing') return [];
      const cards = activeRequestId
        ? toolCards.filter((c) => c.requestId === activeRequestId)
        : toolCards;
      return cards;
    },
    [toolCards, activeRequestId, livePhase, phase]
  );

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

  const applyMention = useCallback(
    (item: MentionItem) => {
      // Read the composer store — inputRef.value can be empty on click (blur).
      const value = aui.composer.getState().text;
      let at = -1;
      for (let i = value.length - 1; i >= 0; i -= 1) {
        if (value[i] !== '@') continue;
        if (i === 0 || /\s/.test(value[i - 1] ?? '')) {
          at = i;
          break;
        }
      }
      if (at < 0) return;
      const insert = item.text;
      const next = `${value.slice(0, at)}@${insert} `;
      aui.composer.setText(next);
      setMentionOpen(false);
      setMentionQuery('');
      inputRef.current?.focus();
      const el = inputRef.current;
      if (el) {
        const caret = next.length;
        el.setSelectionRange(caret, caret);
      }
    },
    [aui]
  );

  const insertMention = useCallback(
    (item: MentionItem) => {
      // Choosing someone not in the room adds them, then mentions them (ADR 0010 §5).
      if (item.kind === 'agent' && item.notInChannel && item.agentSlug && onAddChannelMember) {
        setMentionOpen(false);
        void onAddChannelMember(item.agentSlug).then((added) => {
          if (added) applyMention(item);
        });
        return;
      }
      applyMention(item);
    },
    [applyMention, onAddChannelMember]
  );

  const handleMentionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!mentionOpen || mentionItems.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionItems.length) % mentionItems.length
        );
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionOpen(false);
        setMentionQuery('');
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        const item = mentionItems[mentionIndex] ?? mentionItems[0];
        if (item) insertMention(item);
      }
    },
    [insertMention, mentionIndex, mentionItems, mentionOpen]
  );

  /** Checks shared by Enter and the Send button; false when nothing may go out yet. */
  const prepareSend = useCallback((): boolean => {
    if (connecting || phase === 'restarting' || offlinePrompt) return false;
    if (resolvedInference?.slot === 'local' && resolvedInference.health === 'unreachable') {
      setOfflinePrompt(true);
      return false;
    }
    applyQuote();
    return true;
  }, [applyQuote, connecting, offlinePrompt, phase, resolvedInference]);

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      handleMentionKeyDown(event);
      if (event.defaultPrevented) return;
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      // When it passes, the composer's own Enter handler runs next and sends.
      if (!prepareSend()) event.preventDefault();
    },
    [handleMentionKeyDown, prepareSend]
  );

  const approval = approvals[0] ?? null;
  const credentialRequest = credentialRequests[0] ?? null;

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
      inRoom: Boolean(isChannel),
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

  useEffect(() => {
    if (!approval) return;
    if (ackedApprovalRef.current === approval.rpcRequestId) return;
    ackedApprovalRef.current = approval.rpcRequestId;
    void hermesChatIPC.ackApproval({
      sessionId: approval.sessionId,
      approvalRequestId: approval.approvalRequestId,
    });
  }, [approval]);

  const respondApproval = useCallback(
    async (choice: HermesApprovalChoice) => {
      if (!approval) return;
      setApprovalBusy(true);
      try {
        const result = await hermesChatIPC.respondApproval({
          rpcRequestId: approval.rpcRequestId,
          choice,
        });
        if (result.success) {
          setApprovals((prev) =>
            prev.filter((item) => item.rpcRequestId !== approval.rpcRequestId)
          );
        }
      } finally {
        setApprovalBusy(false);
      }
    },
    [approval]
  );

  const respondCredential = useCallback(
    async (answer: Omit<HermesChatCredentialRespondPayload, 'rpcRequestId'>) => {
      if (!credentialRequest) return;
      const rpcRequestId = credentialRequest.rpcRequestId;
      setCredentialBusy(true);
      setCredentialError(null);
      try {
        const result = await hermesChatIPC.respondCredentialRequest({ rpcRequestId, ...answer });
        if (result.success) {
          setCredentialRequests((prev) => prev.filter((item) => item.rpcRequestId !== rpcRequestId));
          if (credentialRequest.kind === 'vault.save_login' && answer.login) {
            setSavedLogin({
              site: credentialRequest.site ?? credentialRequest.origin ?? 'this site',
              agentSlug: liveSpeakerSlug ?? agent?.slug ?? BUILTIN_AGENT_FALLBACK.slug,
            });
          }
        } else {
          setCredentialError(result.error ?? 'Could not send that. Try again.');
          // Main no longer holds it (answered elsewhere or timed out): drop the card.
          if (result.error?.startsWith('No pending')) {
            setCredentialRequests((prev) => prev.filter((item) => item.rpcRequestId !== rpcRequestId));
            setCredentialError(null);
          }
        }
      } finally {
        setCredentialBusy(false);
      }
    },
    [agent?.slug, credentialRequest, liveSpeakerSlug]
  );

  useEffect(() => {
    setSavedLogin(null);
  }, [sessionId]);

  // Run control (run-control spec Phase 1): one button in the input's corner sends while
  // idle and stops while a run is in flight. There is no Stop while nothing runs.
  const running = useAuiState((s) => s.thread.isRunning);
  const hasDraft = useAuiState((s) => s.composer.text.trim().length > 0);
  const runStartedAtRef = useRef(0);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!running) return;
    runStartedAtRef.current = Date.now();
    setAnnouncement('');
  }, [running]);

  const stopRun = useCallback(() => {
    // A double-click on Send must not land its second click as Stop.
    if (Date.now() - runStartedAtRef.current < STOP_GUARD_MS) return;
    if (approval?.choices.includes('deny')) void respondApproval('deny');
    if (credentialRequest) void respondCredential({});
    aui.thread.cancelRun();
    setAnnouncement('Response stopped');
  }, [approval, aui, credentialRequest, respondApproval, respondCredential]);

  const sendFromButton = useCallback(() => {
    if (!prepareSend()) return;
    (aui.composer as { send?: () => void }).send?.();
    inputRef.current?.focus();
  }, [aui, prepareSend]);

  // Esc stops a run from anywhere in the chat pane, but only once nothing else claims
  // it: open menus and lists close first, and a text selection's Quote popover clears.
  const onPaneKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !running) return;
      const pane = event.currentTarget;
      if (pane.querySelector('.wb-sel-pop')) {
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        return;
      }
      if (pane.querySelector('[role="menu"], [role="listbox"], [role="dialog"]')) return;
      event.preventDefault();
      stopRun();
    },
    [running, stopRun]
  );

  const retryLocal = useCallback(async () => {
    const probed = await onboardingIPC.probeSlotHealth({ slot: 'local' });
    if (probed.health !== 'reachable') return;
    setOfflinePrompt(false);
    applyQuote();
    (aui.composer as { send?: () => void }).send?.();
  }, [aui, applyQuote]);

  const sendViaOpenRouter = useCallback(async () => {
    if (!sessionId) return;
    const status = await onboardingIPC.getStatus();
    const modelId = status.slots.openrouter?.modelId;
    if (!status.slots.openrouter?.configured || !modelId) return;
    await hermesChatIPC.setSessionInference({
      sessionId,
      provider: 'openrouter',
      modelId,
    });
    setOfflinePrompt(false);
    applyQuote();
    (aui.composer as { send?: () => void }).send?.();
  }, [aui, applyQuote, sessionId]);

  const channelHead = isChannel ? formatChannelHead(channel, threadTitle) : null;
  const headTitle = channelHead?.title
    ?? (threadTitle.trim() || agent?.displayName || builtinAgentName(agents));
  const isHermesChat = !isChannel && kind === 'hermes';
  const isSideChat = !isChannel && kind === 'side';
  const agentName = agent?.displayName ?? builtinAgentName(agents);
  // Every head names the kind in words, beside the same mark as the rail row (ADR 0023).
  const markKind: HermesConversationKind = isChannel ? 'channel' : kind ?? 'dm';
  const headKind = headKindLine({ kind: markKind, agents, agentName, startedAt });
  const waitingForApproval = Boolean(approval);
  const waitingForCredential = Boolean(credentialRequest);
  const composerPhase =
    connecting
      ? 'Connecting folder…'
      : applyError
        ? applyError
        : !rpcAvailable && activeProject
        ? 'Folder connected · project RPC unavailable'
        : waitingForCredential
          ? 'Waiting for your answer'
        : waitingForApproval
          ? approvals.length > 1
            ? `Waiting for approval · ${approvals.length}`
            : 'Waiting for approval'
          : phaseLine;

  const agentMentionItems = mentionItems.filter((i) => i.kind === 'agent');
  const fileMentionItems = mentionItems.filter((i) => i.kind === 'file');
  const composerPlaceholder = connecting
    ? 'Connecting folder…'
    : phase === 'restarting'
      ? 'Wait for the assistant to come back…'
      : offlinePrompt
        ? 'Local model is unreachable…'
      : credentialRequest
        ? 'Answer the prompt above to continue…'
      : approval
        ? 'Answer the approval to continue…'
        : isHermesChat
          ? `Ask ${agentName} anything`
          : isSideChat
            ? `Message ${agentName} · side chat`
          : isChannel
            ? addressingMembers
              ? `Address #${channel?.slug ?? 'channel'} · Enter wakes mentioned members`
              : `Post to #${channel?.slug ?? 'channel'} · @ to address someone now`
            : `Message ${speakerName}…`;

  const horizon = useMemo(() => {
    if (!isDm) return null;
    const placed = horizonPlacement(historyWindow, threadMessages);
    return placed ? { index: placed.index, label: horizonLabel(agentName, placed.window) } : null;
  }, [isDm, historyWindow, threadMessages, agentName]);
  const contextBudget = isDm ? historyWindow?.budget ?? null : null;

  return (
    <ThreadPrimitive.Root
      className="relative flex h-full min-h-0 flex-col"
      onKeyDown={onPaneKeyDown}
    >
      <div className="wb-thread-head">
        <div className="wb-thread-id">
          <ConversationMark kind={markKind} agent={agent} size={24} />
          <span className="wb-thread-id-copy">
            {filed ? (
              <span className="wb-crumbs">
                <button
                  type="button"
                  className="wb-crumb"
                  onClick={onOpenProject}
                  title={`Open ${activeProject?.name ?? 'No project'}`}
                >
                  <ProjectGlyph project={activeProject} />
                  <span className="wb-crumb-name" title={activeProject?.name ?? 'No project'}>
                    {activeProject?.name ?? 'No project'}
                  </span>
                </button>
                <span className="wb-crumb-sep" aria-hidden="true">
                  /
                </span>
                <span className="wb-title-menu">
                  <button
                    type="button"
                    className={`wb-crumb-title${titleMenuOpen ? ' is-open' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={titleMenuOpen}
                    onClick={() => setTitleMenuOpen((open) => !open)}
                  >
                    <strong className={isChannel ? 'mono' : undefined} title={headTitle}>
                      {headTitle}
                    </strong>
                    <span className="wb-proj-chev" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {titleMenuOpen ? (
                    <div className="wb-insp-menu wb-title-menu-pop" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!onMoveProject || Boolean(moveDisabledReason)}
                        title={moveDisabledReason ?? undefined}
                        onClick={() => {
                          setTitleMenuOpen(false);
                          onMoveProject?.();
                        }}
                      >
                        Move to project…
                      </button>
                      {moveDisabledReason ? (
                        <p className="wb-title-menu-note">{moveDisabledReason}</p>
                      ) : null}
                      {isHermesChat && onMakeChannel ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setTitleMenuOpen(false);
                            onMakeChannel();
                          }}
                        >
                          Make channel
                        </button>
                      ) : null}
                      {isChannel && onRenameChannel ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setTitleMenuOpen(false);
                            onRenameChannel();
                          }}
                        >
                          Rename channel…
                        </button>
                      ) : null}
                      {isChannel && onDeleteChannel ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setTitleMenuOpen(false);
                            onDeleteChannel();
                          }}
                        >
                          Delete channel…
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </span>
              </span>
            ) : (
              <strong className={isChannel ? 'mono' : undefined} title={headTitle}>
                {headTitle}
              </strong>
            )}
            <span className="wb-thread-kind">
              {headKind}
              {channelHead?.subtitle ? ` · ${channelHead.subtitle}` : null}
              {branchedFrom ? (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="wb-link wb-branch-from"
                    onClick={branchedFrom.onOpenParent}
                  >
                    from {branchedFrom.parentTitle}
                  </button>
                </>
              ) : null}
            </span>
          </span>
        </div>
        {dmTabs && kind === 'dm' && !isChannel ? (
          <DmTabs active={dmTabs.active} count={dmTabs.count} onChange={dmTabs.onChange} />
        ) : null}
        <span className="wb-grow" aria-hidden="true" />
        <span className="wb-thread-head-actions">
          {isHermesChat && onNewChat ? (
            <button type="button" className="wb-btn-tiny" onClick={onNewChat} title="New chat (⌘N)">
              New chat
            </button>
          ) : null}
          {isSideChat && onOpenAgentDm ? (
            <button type="button" className="wb-btn-tiny" onClick={onOpenAgentDm}>
              Open DM with {agentName}
            </button>
          ) : null}
          {isHermesChat && onMakeChannel ? (
            <button type="button" className="wb-btn-tiny" onClick={onMakeChannel}>
              Make channel
            </button>
          ) : null}
          {!isHermesChat && !isSideChat && !isChannel && agent && onAddAgentToChannel ? (
            <button
              type="button"
              className="wb-btn-tiny"
              onClick={() => onAddAgentToChannel(agent)}
            >
              Add to channel
            </button>
          ) : null}
        </span>
      </div>

      {isDm && findOpen ? <DmFindBar onClose={closeFind} /> : null}

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

      {gauge.empty ? null : (
        <div className="wb-meter">
          <span className="mono">{gauge.label}</span>
          {gauge.showBar && gauge.percent != null ? (
            <div className="wb-usage" aria-hidden="true">
              {barSplit ? (
                <>
                  <i className="oh" style={{ width: `${barSplit.overhead}%` }} title="system / tools" />
                  <i
                    className="out"
                    style={{ width: `${barSplit.conversation}%` }}
                    title="conversation"
                  />
                </>
              ) : (
                <i className="single" style={{ width: `${Math.min(100, gauge.percent)}%` }} />
              )}
            </div>
          ) : null}
          {gauge.showBar && barSplit ? (
            <div className="wb-key">
              <span>
                <i className="k-oh" />
                system / tools
              </span>
              <span>
                <i className="k-out" />
                conversation
              </span>
            </div>
          ) : null}
        </div>
      )}

      <TurnNoteContext.Provider value={turnNoteContext}>
      <ThreadPrimitive.Viewport className="wb-log" role="log" aria-label="Transcript">
        <ThreadPrimitive.Empty>
          <div className="wb-log-empty">
            {connecting ? (
              <p className="wb-log-empty-sub">Connecting folder…</p>
            ) : isChannel ? (
              <>
                <h2>#{channel?.slug ?? 'channel'} is quiet</h2>
                <p className="wb-log-empty-sub">
                  Post for the room; @ a member to ask for a reply.
                </p>
              </>
            ) : (
              <>
                <h2>{activeProject ? `Ask about ${activeProject.name}` : 'What can I help with?'}</h2>
                <p className="wb-log-empty-sub">
                  {activeProject
                    ? 'Files stay on disk. Your assistant reads them where they are.'
                    : 'Replies come from your assistant on this Mac.'}
                </p>
                <div className="wb-starters" role="list" aria-label="Starter prompts">
                  {(activeProject ? PROJECT_STARTERS : GENERAL_STARTERS).map((starter) => (
                    <button
                      key={starter}
                      type="button"
                      role="listitem"
                      className="wb-starter"
                      onClick={() => fillComposer(starter)}
                    >
                      {starter}
                    </button>
                  ))}
                </div>
                <p className="wb-log-empty-keys">
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd> <kbd>Enter</kbd> for a new line ·{' '}
                  <kbd>@</kbd> to mention
                </p>
              </>
            )}
          </div>
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

        {projectMarks.map((mark) => (
          <div key={mark.id} className="wb-switch-mark wb-project-mark">
            {projectMarkText(mark, projects, agentName)}
          </div>
        ))}

        {inferenceMarks.map((mark) => (
          <div key={mark.id} className="wb-switch-mark">
            {mark.kind === 'restarting'
              ? `Switching to ${inferenceSlotLabel(mark.provider)} · restarting assistant…`
              : `Switched to ${formatInferenceChipTitle(mark.provider, mark.modelId)}`}
          </div>
        ))}

        {phase === 'preparing' || phase === 'restarting' ? (
          <div className="wb-msg">
            <div className="wb-phase-line">
              <i className="wb-spin" aria-hidden />
              {phaseLine || 'Preparing…'}
            </div>
          </div>
        ) : null}

        {visibleToolCards.length > 0 ? (
          <div className="wb-msg" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visibleToolCards.map((card) => (
              <ToolCard
                project={activeProject}
                onNotice={setNotice}
                key={card.toolId}
                card={card}
                onToggle={() => {
                  setToolCards((prev) =>
                    prev.map((c) =>
                      c.toolId === card.toolId ? { ...c, collapsed: !c.collapsed } : c
                    )
                  );
                }}
              />
            ))}
          </div>
        ) : null}

        {setupOffer ? (
          <div className="wb-msg">
            <SetupOfferCard onDismiss={() => clearSetupOffer(setupOffer.chatId)} />
          </div>
        ) : null}

        {statsRows.length > 0 ? (
          <div className="wb-msg">
            <div className="wb-stats">
              {statsRows.map((row) => (
                <div key={row.label}>
                  <b>{row.value}</b>
                  {row.label}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </ThreadPrimitive.Viewport>
      </TurnNoteContext.Provider>

      {credentialRequest ? (
        <CredentialInterrupt
          request={credentialRequest}
          queueSize={credentialRequests.length + approvals.length}
          busy={credentialBusy}
          error={credentialError}
          onRespond={(answer) => void respondCredential(answer)}
        />
      ) : approval ? (
        <ApprovalInterrupt
          approval={approval}
          queueSize={approvals.length}
          busy={approvalBusy}
          onRespond={(choice) => void respondApproval(choice)}
        />
      ) : hostApprovals.approval ? (
        <HostBridgeApproval
          approval={hostApprovals.approval}
          queueSize={hostApprovals.queueSize}
          busy={hostApprovals.busy}
          onRespond={(choice) => void hostApprovals.respond(choice)}
        />
      ) : codingAccess.request ? (
        <CodingAccessInterrupt
          request={codingAccess.request}
          projectName={
            projects.find((project) => project.id === codingAccess.request?.projectId)?.name ??
            null
          }
          queueSize={codingAccess.queueSize}
          onResolved={(followUp) => {
            if (codingAccess.request) codingAccess.resolve(codingAccess.request);
            // One short, visible turn so Hermes retries in the folder it can now reach.
            if (followUp) {
              aui.composer.setText(followUp);
              (aui.composer as { send?: () => void }).send?.();
            }
          }}
        />
      ) : savedLogin ? (
        <div className="wb-saved-login" role="status">
          <span>
            Saved the login for <span className="mono">{savedLogin.site}</span>. The model never saw
            the password.
          </span>
          <button
            type="button"
            className="wb-saved-login-link"
            onClick={() => {
              openSettings({ tab: 'passwords', agentSlug: savedLogin.agentSlug });
              setSavedLogin(null);
            }}
          >
            Manage in Passwords &amp; Logins
          </button>
          <button
            type="button"
            className="wb-saved-login-close"
            aria-label="Dismiss"
            onClick={() => setSavedLogin(null)}
          >
            ×
          </button>
        </div>
      ) : hostTools === 'waiting' || hostTools === 'off' ? (
        // Hermes retries a missing MCP server only every few minutes, so the chat can be ready
        // well before Boundary's tools are. Say so rather than let Hermes improvise.
        <div className="wb-host-tools-note" role="status">
          {hostTools === 'waiting'
            ? "Connecting Hermes to Boundary's tools…"
            : "Boundary's tools aren't running. Restart Boundary to try again."}
          <InfoTip label="Boundary's tools">
            {hostTools === 'waiting'
              ? "Until then Hermes can't send notifications, open links or use your files and clipboard. This usually takes a few seconds, but can take a few minutes on an older stack."
              : "Until they are, Hermes can't send notifications, open links or use your files and clipboard."}
          </InfoTip>
        </div>
      ) : null}

      <div
        className={`wb-composer${approval || credentialRequest || phase === 'restarting' ? ' is-locked' : ''}`}
      >
        {mentionOpen && mentionItems.length > 0 ? (
          <div className="wb-mentions" role="listbox" aria-label="Mention">
            {agentMentionItems.length > 0 ? (
              <div className="wb-mention-head">Agents</div>
            ) : null}
            {agentMentionItems.map((item, i) => (
              <button
                key={`agent:${item.agentSlug}`}
                type="button"
                role="option"
                aria-selected={mentionIndex === i}
                className={mentionIndex === i ? 'is-active' : undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(item);
                }}
              >
                <ConversationMark
                  kind={item.agentSlug === BUILTIN_AGENT_FALLBACK.slug ? 'hermes' : 'dm'}
                  agent={{ slug: item.agentSlug, displayName: item.display }}
                />
                <span>
                  {item.display}
                  {item.meta ? (
                    <>
                      <br />
                      <span className="meta">{item.meta}</span>
                    </>
                  ) : null}
                </span>
              </button>
            ))}
            {fileMentionItems.length > 0 ? (
              <div className="wb-mention-head">Files</div>
            ) : null}
            {fileMentionItems.map((item, i) => {
              const globalIndex = agentMentionItems.length + i;
              return (
                <button
                  key={`file:${item.text}`}
                  type="button"
                  role="option"
                  aria-selected={mentionIndex === globalIndex}
                  className={mentionIndex === globalIndex ? 'is-active' : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(item);
                  }}
                >
                  <span className="mono" title={item.display ?? item.text}>
                    {item.display ?? item.text}
                  </span>
                  {item.meta ? <span className="meta">{item.meta}</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <SelectionQuote onQuote={onQuote} />
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
                  <button type="button" className="wb-btn" onClick={() => void retryLocal()}>
                    Retry local
                  </button>
                  {openRouterConfigured ? (
                    <button
                      type="button"
                      className="wb-btn is-solid"
                      onClick={() => void sendViaOpenRouter()}
                    >
                      Send via OpenRouter
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className="wb-input-box">
              <ComposerPrimitive.Input
                ref={inputRef as never}
                rows={2}
                placeholder={composerPlaceholder}
                disabled={connecting || Boolean(approval || credentialRequest) || phase === 'restarting'}
                // The pane owns Esc (onPaneKeyDown): open lists close first, and the
                // double-click guard applies. The input's own Esc-cancel skips both.
                cancelOnEscape={false}
                onKeyDown={handleComposerKeyDown}
                title={
                  mentionOpen && mentionItems.length > 0
                    ? 'Enter to select mention · Esc to dismiss'
                    : phase === 'restarting'
                      ? 'Wait for the assistant to come back'
                      : 'Press Enter to send'
                }
              />
              {running || !(connecting || phase === 'restarting' || offlinePrompt) ? (
                <RunButton
                  running={running}
                  held={Boolean(approval || credentialRequest)}
                  canSend={hasDraft}
                  onSend={sendFromButton}
                  onStop={stopRun}
                />
              ) : null}
            </div>
            <div className="wb-cluster">
              {onMoveProject && (isDm || messageCount > 0) ? (
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
                  <ProjectGlyph project={activeProject} size={12} />
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
                disabled={connecting || phase === 'restarting'}
                applying={phase === 'restarting'}
                projectInferenceKey={
                  activeProject
                    ? `${activeProject.id}:${activeProject.inference?.mode ?? 'inherit'}:${activeProject.inference?.modelId ?? ''}`
                    : null
                }
                onResolvedChange={setResolvedInference}
                onMarksChange={setInferenceMarks}
              />
              {contextBudget != null ? (
                <DmContextChip budget={contextBudget} agentName={agentName} />
              ) : null}
              <button
                type="button"
                className="wb-chip"
                disabled={connecting}
                onClick={() => {
                  setMentionOpen(true);
                  setMentionQuery('');
                  inputRef.current?.focus();
                }}
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={toolsEnabled}
                  onClick={() => onToolsEnabledChange(!toolsEnabled)}
                  className={`wb-switch${toolsEnabled ? ' is-on' : ''}`}
                >
                  <i />
                </button>
              </label>
            </div>
          </ComposerPrimitive.Root>
        </Profiler>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </ThreadPrimitive.Root>
  );
};

/**
 * Send ↑ while idle, Stop ■ while a run is in flight (run-control spec 1.1). One element
 * whose glyph and label change, so keyboard focus survives the swap. A ring traces it
 * while the agent works; it pauses and turns amber while an approval waits.
 */
const RunButton: React.FC<{
  running: boolean;
  held: boolean;
  canSend: boolean;
  onSend: () => void;
  onStop: () => void;
}> = ({ running, held, canSend, onSend, onStop }) => {
  const tip = running
    ? held
      ? 'Stop · denies the pending request · Esc'
      : 'Stop · Esc'
    : canSend
      ? 'Send · Enter'
      : undefined;
  return (
    <button
      type="button"
      className={`wb-run${running ? ' is-run' : ''}${held ? ' is-held' : ''}`}
      aria-label={running ? 'Stop response' : 'Send message'}
      aria-disabled={!running && !canSend}
      data-tip={tip}
      onClick={running ? onStop : canSend ? onSend : undefined}
    >
      <span className="wb-run-ring" aria-hidden="true" />
      <svg className="wb-run-send" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 13V3.5M3.8 7.5L8 3.3l4.2 4.2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg className="wb-run-stop" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <rect x="4" y="4" width="8" height="8" rx="1.6" />
      </svg>
    </button>
  );
};

/**
 * A prompt as sent. One that starts with a quote (Quote in reply, spec Phase 4) shows the
 * quote as a block above the text; anything else renders like assistant-ui's default.
 */
const UserText: React.FC<{ text: string }> = ({ text }) => {
  const { quote, body } = splitLeadingQuote(text);
  return (
    <>
      {quote ? <blockquote className="wb-user-quote">{quote}</blockquote> : null}
      {body ? <p style={{ whiteSpace: 'pre-line' }}>{body}</p> : null}
    </>
  );
};

const USER_CONTENT_COMPONENTS = { Text: UserText };

/** Prompts taller than this many lines collapse (ADR 0021 follow-up for long pastes)… */
const COLLAPSE_AFTER_LINES = 16;

/**
 * A prompt bubble. Long pastes collapse to 12 lines behind "Show more", so a pasted
 * document does not fill the log; Copy and Edit still use the whole text.
 */
const UserBubble: React.FC = () => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return undefined;
    const measure = () => {
      const line = parseFloat(getComputedStyle(body).lineHeight) || 23;
      setOverflowing(body.scrollHeight > line * COLLAPSE_AFTER_LINES);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const collapsed = overflowing && !expanded;
  return (
    <div className={`wb-bubble${collapsed ? ' is-collapsed' : ''}`}>
      <div className="wb-bubble-body" ref={bodyRef}>
        <MessagePrimitive.Content components={USER_CONTENT_COMPONENTS} />
      </div>
      {overflowing ? (
        <button
          type="button"
          className="wb-show-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
};

// ADR 0021: your turns hug the right edge with no "You" label; alignment says who spoke.
const UserMessage: React.FC = () => {
  const { speakerName, inRoom } = useContext(AssistantMessageContext);
  return (
    <MessagePrimitive.Root className={`wb-msg is-user${useBeyondHorizon() ? ' is-beyond-horizon' : ''}`}>
      <BranchMarkBefore />
      <DmHorizonMark />
      <DayDivider />
      <UserBubble />
      <UserMessageActions />
      <UnansweredNote speakerName={speakerName} inRoom={inRoom} />
    </MessagePrimitive.Root>
  );
};

// Message components must keep a stable identity: ThreadPrimitive.Messages
// compares them by reference and remounts every message when they change.
const AssistantText: React.FC<{ text: string }> = ({ text }) => {
  const { dismissedDrafts, onDismissDraft, onCreateDraft, onEditDraft } =
    useContext(AssistantMessageContext);
  const draft = useMemo(() => parseAgentDraft(text), [text]);
  // Invented tags such as <action>/<result> would be stripped silently; show them as text.
  // A parsed draft shows as the card, so its raw fence is left out (ADR 0010 §6).
  const rendered = useMemo(
    () => escapeUnknownTags(draft ? stripAgentDraftFence(text) : text),
    [draft, text]
  );
  const draftKey = draft
    ? `${draft.displayName}:${draft.handle}:${draft.role.slice(0, 40)}`
    : '';
  const showDraft = Boolean(draft) && draftKey && !dismissedDrafts.has(draftKey);
  return (
    <>
      <Streamdown className="wb-streamdown">{rendered}</Streamdown>
      {showDraft && draft ? (
        <div className="wb-draft-card">
          <div className="wb-sheet-kicker">Proposed agent</div>
          <h3>{draft.displayName}</h3>
          <div className="handle mono">
            @{draft.handle}
          </div>
          <p>{draft.role}</p>
          <p className="wb-hint" style={{ padding: 0 }}>
            Private memory. Shared folder when a project is bound. Not in
            any channel yet.
          </p>
          <div className="wb-draft-actions">
            <button
              type="button"
              className="wb-btn-solid"
              onClick={() =>
                onCreateDraft?.({
                  displayName: draft.displayName,
                  handle: draft.handle,
                  role: draft.role,
                })
              }
            >
              Create agent
            </button>
            <button
              type="button"
              className="wb-btn-ghost"
              onClick={() => onEditDraft?.(draft)}
            >
              Edit first
            </button>
            <button
              type="button"
              className="wb-btn-tiny"
              onClick={() => onDismissDraft(draftKey)}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
};

const ASSISTANT_CONTENT_COMPONENTS = { Text: AssistantText };

/** The reply's own speaker when history recorded one, else the conversation's. */
function useReplySpeaker(): { name: string; agent: AgentProfile | null } {
  const { speakerName, agents } = useContext(AssistantMessageContext);
  const slug = useAuiState(
    (s) => (s.message.metadata as { custom?: { agentSlug?: unknown } } | undefined)?.custom?.agentSlug
  );
  const agent = typeof slug === 'string' ? agents.find((a) => a.slug === slug) ?? null : null;
  if (agent) return { name: agent.displayName, agent };
  return { name: speakerName, agent: agents.find((a) => a.displayName === speakerName) ?? null };
}

/** A reply's speaker line; in rooms it carries the agent's mark (ADR 0023). */
const WhoLine: React.FC<{ name: string; agent: AgentProfile | null }> = ({ name, agent }) => {
  const { inRoom } = useContext(AssistantMessageContext);
  return (
    <div className="wb-who">
      {inRoom && agent ? (
        <ConversationMark kind={agent.builtIn ? 'hermes' : 'dm'} agent={agent} size={14} />
      ) : null}
      {name}
    </div>
  );
};

type SpeakerSection = SpeakerSegment & { name: string; agent: AgentProfile | null };

/** Each agent's part of a live room wake, named like a reply of its own (ADR 0010 §1). */
function useSpeakerSections(): SpeakerSection[] | null {
  const { speakerName, agents } = useContext(AssistantMessageContext);
  const custom = useAuiState(
    (s) => (s.message.metadata as { custom?: unknown } | undefined)?.custom
  );
  const segments = speakerSegmentsOf(custom);
  if (!segments) return null;
  return segments.map((segment) => {
    const agent = agents.find((a) => a.slug === segment.agentSlug) ?? null;
    return { ...segment, agent, name: agent?.displayName ?? speakerName };
  });
}

const AssistantMessage: React.FC = () => {
  const { name: replySpeakerName, agent: speaker } = useReplySpeaker();
  const sections = useSpeakerSections();
  // A stopped or failed wake ends on its last speaker.
  const speakerName = sections?.at(-1)?.name ?? replySpeakerName;
  const beyondHorizon = useBeyondHorizon();
  return (
    <MessagePrimitive.Root
      className={`wb-msg is-assistant${beyondHorizon ? ' is-beyond-horizon' : ''}`}
    >
      <BranchMarkBefore />
      <DmHorizonMark />
      <DayDivider />
      {sections ? (
        sections.map((section, i) => (
          <div key={i} className={i > 0 ? 'wb-speaker-turn' : undefined}>
            <WhoLine name={section.name} agent={section.agent} />
            <div className="wb-prose">
              <AssistantText text={section.text} />
            </div>
          </div>
        ))
      ) : (
        <>
          <WhoLine name={replySpeakerName} agent={speaker} />
          <div className="wb-prose">
            <MessagePrimitive.Content components={ASSISTANT_CONTENT_COMPONENTS} />
          </div>
        </>
      )}
      <ReplyFiles />
      <FiledTaskCards />
      <ReplyEnding speakerName={speakerName} />
      <LiveNoReplyNote speakerName={speakerName} />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="wb-msg-error" role="alert">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <AssistantMessageActions />
    </MessagePrimitive.Root>
  );
};

const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage, EditComposer: UserEditComposer };

/** Raw tool paths → the ones inside this project's mount, relative to it. */
function projectPathsOf(paths: string[], containerPath?: string | null): string[] {
  return uniquePreserveOrder(
    paths
      .map((p) => projectRelativePath(p, containerPath))
      .filter((p): p is string => p != null)
  );
}

/** A file the agent touched: Reveal and Copy path on hover, when it maps to the host. */
const ToolPath: React.FC<{
  path: string;
  project: HermesProjectRecord | null;
  revealable: boolean;
  onNotice: (text: string) => void;
}> = ({ path, project, revealable, onNotice }) =>
  revealable && project ? (
    <li className="mono wb-tool-path">
      <span>{path}</span>
      <FileActions project={project} relativePath={path} onNotice={onNotice} />
    </li>
  ) : (
    <li className="mono" title={path}>
      {path}
    </li>
  );

const ToolCard: React.FC<{
  card: ToolCardState;
  onToggle: () => void;
  project?: HermesProjectRecord | null;
  onNotice?: (text: string) => void;
}> = ({ card, onToggle, project = null, onNotice = () => undefined }) => {
  const projectPaths = new Set(card.projectPaths ?? []);
  const row = (p: string) => (
    <ToolPath
      key={p}
      path={p}
      project={project}
      revealable={projectPaths.has(p)}
      onNotice={onNotice}
    />
  );
  const meta = formatToolCardMeta({
    name: card.name,
    status: card.status,
    turn: card.turn,
    maxTurns: card.maxTurns,
  });
  const running = card.status === 'running' || card.status === 'generating';
  const paths = card.paths ?? [];
  const collapsed = card.collapsed !== false && !running;

  return (
    <div className="wb-tool">
      <button type="button" onClick={onToggle} className="meta">
        {running ? <i className="wb-spin" aria-hidden /> : null}
        <span className="label" title={meta}>
          {meta}
        </span>
        {card.durationSec != null && !running ? (
          <span className="dur">{card.durationSec.toFixed(1)}s</span>
        ) : null}
      </button>
      {!collapsed ? (
        <div>
          {card.summary ? <p className="summary">{card.summary}</p> : null}
          {paths.length > 0 ? <ul>{paths.map(row)}</ul> : null}
        </div>
      ) : paths.length > 0 ? (
        <ul>
          {paths.slice(0, 4).map(row)}
          {paths.length > 4 ? <li>+{paths.length - 4} more</li> : null}
        </ul>
      ) : null}
    </div>
  );
};
