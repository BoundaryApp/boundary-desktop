import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActionBarPrimitive, ErrorPrimitive, MessagePrimitive } from '@assistant-ui/react';
import { useAuiState } from '@assistant-ui/store';
import { useOwnerDocument } from '../../components/ui/ownerDocument';
import { Streamdown } from 'streamdown';
import type { AgentDraftProposal, AgentProfile } from '../../../shared/types/hermesChat';
import { BUILTIN_AGENT_FALLBACK } from '../../../shared/hermesAgentIdentity';
import { escapeUnknownTags, splitLeadingQuote } from '../../../shared/markdownText';
import {
  AssistantMessageActions,
  BranchMarkBefore,
  ReplyEnding,
  ReplyFiles,
  UserEditComposer,
  UserMessageActions,
} from './MessageActions';
import { FiledTaskCards } from './TaskCards';
import { LiveNoReplyNote, UnansweredNote } from './TurnNotes';
import { DayDividerWithMarks } from './TranscriptMarks';
import { PoolReplyLine } from './PoolReplyLine';
import { AgentMark } from './ConversationMark';
import { DmHorizonMark, useBeyondHorizon } from './DmThreadTools';
import { parseAgentDraft, stripAgentDraftFence } from './agentDraft';
import type { SpeakerSegment } from './speakerSegments';
import { messageCustom, useMessageCustom } from './messageCustom';
import { usePacedText } from './usePacedText';
import { Button } from '../../components/ui/button';

// The transcript's message components. They must keep a stable identity:
// ThreadPrimitive.Messages compares them by reference and remounts every message when they change.

export interface AssistantMessageContextValue {
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

export const AssistantMessageContext = createContext<AssistantMessageContextValue>({
  speakerName: BUILTIN_AGENT_FALLBACK.displayName,
  agents: [],
  inRoom: false,
  dismissedDrafts: new Set(),
  onDismissDraft: () => undefined,
});

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
  const messageId = useAuiState((s) => s.message.id);
  return (
    <MessagePrimitive.Root
      className={`wb-msg is-user${useBeyondHorizon() ? ' is-beyond-horizon' : ''}`}
      data-message-id={messageId}
    >
      <BranchMarkBefore />
      <DmHorizonMark />
      <DayDividerWithMarks />
      <UserBubble />
      <UserMessageActions />
      <UnansweredNote speakerName={speakerName} inRoom={inRoom} />
    </MessagePrimitive.Root>
  );
};

/** Word fade for paced text; Streamdown leaves code, math and the like unanimated. */
const REVEAL_ANIMATION = { animation: 'fadeIn', sep: 'word', duration: 150 } as const;

/**
 * `streaming` says whether this text is still growing; it defaults to the message's
 * running state. A room wake's earlier speakers are done while the message still runs.
 */
const AssistantText: React.FC<{ text: string; streaming?: boolean }> = ({ text, streaming }) => {
  // Its link, code and table overlays draw where the reply is, the desktop panel included.
  const overlayRoot = useOwnerDocument().body;
  const { dismissedDrafts, onDismissDraft, onCreateDraft, onEditDraft } =
    useContext(AssistantMessageContext);
  const messageRunning = useAuiState((s) => s.message.status?.type === 'running');
  const paced = usePacedText(text, streaming ?? messageRunning);
  const draft = useMemo(() => parseAgentDraft(text), [text]);
  // Invented tags such as <action>/<result> would be stripped silently; show them as text.
  // A parsed draft shows as the card, so its raw fence is left out (ADR 0010 §6).
  const rendered = useMemo(
    () => escapeUnknownTags(draft ? stripAgentDraftFence(paced.text) : paced.text),
    [draft, paced.text]
  );
  const draftKey = draft
    ? `${draft.displayName}:${draft.handle}:${draft.role.slice(0, 40)}`
    : '';
  // The card waits for the reveal, so it never shows ahead of the text it follows.
  const showDraft = Boolean(draft) && draftKey && !paced.pacing && !dismissedDrafts.has(draftKey);
  return (
    <>
      <Streamdown
        className="wb-streamdown"
        portal={overlayRoot}
        isAnimating={paced.pacing}
        {...(paced.pacing ? { animated: REVEAL_ANIMATION } : {})}
      >
        {rendered}
      </Streamdown>
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
            <Button
              variant="primary"
              block
              type="button"
              onClick={() =>
                onCreateDraft?.({
                  displayName: draft.displayName,
                  handle: draft.handle,
                  role: draft.role,
                })
              }
            >
              Create agent
            </Button>
            <Button
              variant="secondary"
              block
              type="button"
              onClick={() => onEditDraft?.(draft)}
            >
              Edit first
            </Button>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => onDismissDraft(draftKey)}
            >
              Dismiss
            </Button>
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
  const slug = useAuiState((s) => messageCustom(s.message).agentSlug);
  const agent = slug ? agents.find((a) => a.slug === slug) ?? null : null;
  if (agent) return { name: agent.displayName, agent };
  return { name: speakerName, agent: agents.find((a) => a.displayName === speakerName) ?? null };
}

/** A reply's speaker line; in rooms it carries the agent's mark (ADR 0023). */
const WhoLine: React.FC<{ name: string; agent: AgentProfile | null; voiceName?: string }> = ({
  name,
  agent,
  voiceName,
}) => {
  const { inRoom } = useContext(AssistantMessageContext);
  return (
    <div className="wb-who">
      {inRoom && agent ? (
        <AgentMark agent={agent} size={14} />
      ) : null}
      {name}
      {voiceName ? <span className="wb-reply-voice">In {voiceName} voice</span> : null}
    </div>
  );
};

type SpeakerSection = SpeakerSegment & { name: string; agent: AgentProfile | null };

/** Each agent's part of a live room wake, named like a reply of its own (ADR 0010 §1). */
function useSpeakerSections(): SpeakerSection[] | null {
  const { speakerName, agents } = useContext(AssistantMessageContext);
  const { segments } = useMessageCustom();
  // A wake one agent answered alone reads as a plain reply.
  if (!segments || segments.length < 2) return null;
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
  const { roomPost } = useMessageCustom();
  const messageId = useAuiState((s) => s.message.id);
  if (roomPost) return null;
  return (
    <MessagePrimitive.Root
      className={`wb-msg is-assistant${beyondHorizon ? ' is-beyond-horizon' : ''}`}
      data-message-id={messageId}
    >
      <BranchMarkBefore />
      <DmHorizonMark />
      <DayDividerWithMarks />
      {sections ? (
        sections.map((section, i) => (
          <div key={i} className={i > 0 ? 'wb-speaker-turn' : undefined}>
            <WhoLine name={section.name} agent={section.agent} voiceName={section.writingVoiceName} />
            <div className="wb-prose">
              <AssistantText
                text={section.text}
                streaming={i === sections.length - 1 ? undefined : false}
              />
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
      <PoolReplyLine />
      <ReplyFiles />
      <FiledTaskCards />
      <ReplyEnding />
      <LiveNoReplyNote speakerName={speakerName} />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="wb-msg-error" role="alert">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
        {/* The send never reached Hermes (stack unreachable, decision D3): run it again. */}
        <ActionBarPrimitive.Reload className="wb-act" aria-label="Retry">
          Retry
        </ActionBarPrimitive.Reload>
      </MessagePrimitive.Error>
      <AssistantMessageActions />
    </MessagePrimitive.Root>
  );
};

export const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage, EditComposer: UserEditComposer };
