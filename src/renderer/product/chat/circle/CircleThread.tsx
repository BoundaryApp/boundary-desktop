import React, { createContext, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useAuiState } from '@assistant-ui/store';
import { Streamdown, defaultRehypePlugins } from 'streamdown';
import { isReactionEmoji } from '../../../../shared/circleReactions';
import { mentionsMe } from '../../../../shared/circleMentions';
import { REPLIES_FORMAT, repliesToMe } from '../../../../shared/circleReplies';
import type { CircleChannel, CircleMessage, CircleMessageRef, CircleSnapshot } from '../../../../shared/types/circles';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { useOwnerDocument } from '../../../components/ui/ownerDocument';
import { Avatar } from '../../circles/CircleControls';
import type { CircleChatView, MentionPick } from '../../circles/useCircleChat';
import { CopyAction, DayDivider, EditIcon, Icon } from '../MessageActions';
import { MentionMenu } from '../MentionMenu';
import { RunButton } from '../RunButton';
import { takeMessageFocus, useMessageFocusVersion } from '../../circles/circlesNavigation';
import { CirclesMark } from './CirclesMark';
import { mentionTokens, rehypeMentions, unmatchedNames } from './mentionMarks';
import { peopleLine } from './peopleLine';
import { MoreEmojiSheet, ReactButton, ReactionPills } from './Reactions';
import { ReplyQuote, ReplyStrip } from './ReplyQuote';
import { useCircleMentions } from './useCircleMentions';
import { Bubble, DeleteIcon, DeleteSheet, EditBox, ThreadLog, useComposerDraft, useReadWhileFocused, composerKey, rememberedStore, useRemembered, useTextRuntime } from './threadParts';
import { useReplyTargets } from './useReplyTargets';
import { CIRCLE_LINK_SAFETY } from './LinkConfirmSheet';
import { Button } from '../../../components/ui/button';
import './circleChat.css';

/** Messages from one person this close together share a who-line. */
const GROUP_MS = 5 * 60_000;
/** A message never loads anything from the network when it renders (Circle chats spec decision 11). */
const NO_IMAGES = ['img'];

const UNCONFIRMED_TIP = 'Waiting for admins to confirm. Its place in the chat can still change.';

/** How long a message a quote went to stays highlighted (ADR 0053 §7). */
const HIGHLIGHT_MS = 2000;

/**
 * Calls `found` with the element matching `selector` once it exists: now, or when it is added.
 * The runtime renders rows a beat after the messages arrive. Returns a function that stops waiting.
 */
function whenRow(doc: Document, selector: string, found: (row: Element) => void): () => void {
  const now = doc.querySelector(selector);
  if (now) {
    found(now);
    return () => undefined;
  }
  const observer = new MutationObserver(() => {
    const row = doc.querySelector(selector);
    if (!row) return;
    observer.disconnect();
    found(row);
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** "Maya is typing…", "Maya and Sam are typing…", "Several people are typing…". */
function typingLine(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return 'Several people are typing…';
}

/**
 * Who has read up to the newest message, from read signals. Only ever a subset of who has read,
 * so the row says when it was seen (decision 12).
 */
const SeenBy: React.FC<{ circle: CircleSnapshot; chat: CircleChatView }> = ({ circle, chat }) => {
  const newest = chat.messages.at(-1);
  if (!newest) return null;
  const seen = circle.members.filter((member) => {
    const ref = chat.seenBy[member.identity];
    return !member.isMe && member.identity !== newest.author && ref?.author === newest.author && ref.id === newest.id;
  });
  if (seen.length === 0) return null;
  const names = seen.map((member) => member.name).join(', ');
  return (
    <div className="wb-circle-seen" title="Seen while you were online" aria-label={`Seen by ${names} while you were online`}>
      {seen.map((member) => (
        <Avatar key={member.identity} name={member.name} seed={member.identity} />
      ))}
      <span aria-hidden="true">Seen</span>
    </div>
  );
};

interface ThreadContextValue {
  circle: CircleSnapshot;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onEdit: (message: CircleMessage, text: string, picked: MentionPick[], channel: boolean) => Promise<string | null>;
  onDelete: (message: CircleMessage) => void;
  onReact: (message: CircleMessage, emoji: string, on: boolean) => void;
  /** Opens the full emoji picker for a message. */
  onMoreEmoji: (message: CircleMessage) => void;
  onPerson?: (identity: string) => void;
  /** Whether @channel counts as a mention of the user in this Circle. */
  channelMentions: boolean;
  /** An admin picking messages to remove: each live message gets a checkbox and no toolbar. */
  selecting: boolean;
  picked: ReadonlySet<string>;
  togglePick: (message: CircleMessage) => void;
  /** Starts a reply to `message` in the composer. */
  onReply: (message: CircleMessage) => void;
  /** A reply's original: `undefined` while it is looked up, `null` when it can't be found. */
  targetOf: (ref: CircleMessageRef) => CircleMessage | null | undefined;
  /** Scrolls to a reply's original and highlights it, loading older pages as needed. */
  goTo: (ref: CircleMessageRef) => void;
  /** The message a quote went to, by `refKey`, while it is highlighted. */
  highlighted: string | null;
  /** Originals that couldn't be reached when the user went to them, by `refKey`. */
  unavailable: ReadonlySet<string>;
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

function useThread(): ThreadContextValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error('CircleThread parts need CircleThread.');
  return value;
}

/** A message's key in the select-mode picks. */
const refKey = (message: CircleMessageRef): string => `${message.author}/${message.id}`;

const circleOf = (message: { metadata?: { custom?: Record<string, unknown> } } | undefined): CircleMessage | null =>
  (message?.metadata?.custom?.circle as CircleMessage | undefined) ?? null;

function toThreadMessage(message: CircleMessage): ThreadMessageLike {
  return {
    id: `${message.author}/${message.id}`,
    role: message.mine && !message.agent ? 'user' : 'assistant',
    content: [{ type: 'text', text: message.text }],
    createdAt: new Date(message.at),
    metadata: { custom: { circle: message } },
  };
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function callLine(message: CircleMessage): string {
  const { call } = message;
  if (!call) return '';
  if (call.ended === undefined) return 'Started a call';
  const minutes = Math.round((call.ended - message.at) / 60_000);
  return minutes < 1 ? 'Call · under a minute' : `Call · ${minutes} min`;
}

const Time: React.FC<{ message: CircleMessage }> = ({ message }) => (
  <time className="wb-circle-time" dateTime={new Date(message.at).toISOString()}>
    {timeLabel(message.at)}
  </time>
);

/**
 * **edited** and the unconfirmed clock when they apply, after the text. `withTime` puts the time
 * first, for messages with no who-line to carry it.
 */
const Stamp: React.FC<{ message: CircleMessage; withTime?: boolean }> = ({ message, withTime = false }) => (
  <span className="wb-circle-stamp">
    {withTime ? <Time message={message} /> : null}
    {message.edited && !message.deleted ? <span>edited</span> : null}
    {message.confirmed ? null : (
      <span className="wb-circle-clock" role="img" aria-label={UNCONFIRMED_TIP} title={UNCONFIRMED_TIP}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    )}
  </span>
);

/**
 * The message's stored mentions as picks, each under the member's current name. Someone who has
 * left is skipped: main would drop them too, and they have no name to match in the text.
 */
function storedPicks(circle: CircleSnapshot, message: CircleMessage): MentionPick[] {
  return (message.mentions?.members ?? []).flatMap((identity) => {
    const member = circle.members.find((m) => m.identity === identity);
    return member ? [{ identity, name: member.name }] : [];
  });
}

const MessageEditBox: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { circle, setEditing, onEdit } = useThread();
  return (
    <EditBox
      initial={message.text}
      onCancel={() => setEditing(null)}
      onSave={(text) => onEdit(message, text, storedPicks(circle, message), message.mentions?.channel ?? false)}
    />
  );
};

/** Whether `message` is aimed at the user: by name, by @channel when they take those, or as a reply to them. */
function mentionsUser(circle: CircleSnapshot, message: CircleMessage, channelMentions: boolean): boolean {
  const me = circle.members.find((member) => member.isMe);
  if (!me) return false;
  return mentionsMe(message.mentions, me.identity, channelMentions) || repliesToMe(message, me.identity);
}

const Body: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const overlayRoot = useOwnerDocument().body;
  const { editing, circle } = useThread();
  const { mentions } = message;
  // Added after Streamdown's own plugins (HTML skipping, sanitising), so the spans we add stay.
  const rehypePlugins = useMemo<NonNullable<React.ComponentProps<typeof Streamdown>['rehypePlugins']>>(
    () => [...Object.values(defaultRehypePlugins), [rehypeMentions, { tokens: mentionTokens(circle, mentions) }]],
    [circle, mentions]
  );
  if (message.deleted) {
    return <p className="wb-circle-gone">{message.deleted === 'admin' ? 'Removed by an admin' : 'Deleted'}</p>;
  }
  if (editing === message.id && message.mine) return <MessageEditBox message={message} />;
  const text = message.text ? (
    <Streamdown
      className="wb-streamdown"
      portal={overlayRoot}
      skipHtml
      disallowedElements={NO_IMAGES}
      rehypePlugins={rehypePlugins}
      linkSafety={CIRCLE_LINK_SAFETY}
    >
      {message.text}
    </Streamdown>
  ) : null;
  const unmatched = unmatchedNames(circle, mentions, message.text);
  const chip = unmatched.length ? <p className="wb-circle-mentioned-chip">Mentioned: {unmatched.join(', ')}</p> : null;
  if (message.shared) {
    return (
      <div className="wb-circle-shared-card">
        <p className="wb-circle-shared">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M5 7l2-2M4.2 5.6L3 6.8a1.7 1.7 0 0 0 2.4 2.4l1.2-1.2M7.8 6.4L9 5.2A1.7 1.7 0 0 0 6.6 2.8L5.4 4"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
          Shared from a chat
          {message.shared.role === 'assistant' && message.shared.model ? ` · reply from ${message.shared.model}` : ''}
        </p>
        {text}
        {chip}
      </div>
    );
  }
  return (
    <>
      {message.call ? <p className="wb-circle-call">{callLine(message)}</p> : null}
      {text}
      {chip}
    </>
  );
};

/** The message each composer draft replies to, by draft key. */
const replyDrafts = rememberedStore<CircleMessage>();

const ReplyIcon = () => (
  <Icon>
    <path d="M6.5 4L3 7.5 6.5 11M3 7.5h6.5A3.5 3.5 0 0 1 13 11v1" />
  </Icon>
);

/**
 * The hover toolbar: icon buttons on the message's top right corner, over the message's own
 * edge, so showing it never covers the next message or reflows the log. It is always mounted and
 * revealed by CSS on hover or focus-within, at every width.
 */
const Actions: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { circle, editing, setEditing, onDelete, onReact, onMoreEmoji, onReply, selecting } = useThread();
  if (message.deleted || editing === message.id || selecting) return null;
  const canReply = circle.format >= REPLIES_FORMAT;
  const canEdit = message.mine && !message.agent && !message.shared;
  // Admins remove other people's messages from select mode, not from here.
  const canDelete = message.mine;
  return (
    <ActionBarPrimitive.Root className="wb-circle-bar" role="toolbar" aria-label="Message actions">
      <ReactButton message={message} onPick={(emoji, on) => onReact(message, emoji, on)} onMore={() => onMoreEmoji(message)} />
      <CopyAction />
      {canReply ? (
        <button type="button" className="wb-act" aria-label="Reply" data-tip="Reply" onClick={() => onReply(message)}>
          <ReplyIcon />
        </button>
      ) : null}
      {canEdit ? (
        <button type="button" className="wb-act" aria-label="Edit" data-tip="Edit" onClick={() => setEditing(message.id)}>
          <EditIcon />
        </button>
      ) : null}
      {canDelete ? (
        <button type="button" className="wb-act" aria-label="Delete" data-tip="Delete" onClick={() => onDelete(message)}>
          <DeleteIcon />
        </button>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

/** The pills under a message; a reactor shows under the Circle's current member name, or as left when absent from it. */
const Pills: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { circle, onReact, selecting } = useThread();
  return (
    <ReactionPills
      message={message}
      readOnly={selecting}
      onToggle={(emoji, on) => onReact(message, emoji, on)}
      memberName={(identity) => circle.members.find((member) => member.identity === identity)?.name}
    />
  );
};

/**
 * Select mode's checkbox and click handling for one message line. A removed message gets
 * neither. A click anywhere on the line toggles it; a click on a link in the text does nothing.
 */
function usePick(message: CircleMessage | null): { line: React.HTMLAttributes<HTMLDivElement>; box: React.ReactNode; on: string } {
  const { selecting, picked, togglePick } = useThread();
  if (!message || !selecting || message.deleted) return { line: {}, box: null, on: '' };
  const isOn = picked.has(refKey(message));
  return {
    on: isOn ? ' is-picked' : '',
    line: {
      onClick: (event) => {
        if ((event.target as HTMLElement).closest('a')) event.preventDefault();
        togglePick(message);
      },
    },
    box: (
      <input
        type="checkbox"
        className="wb-circle-pick-box"
        aria-label={`Select ${message.mine ? 'your message' : `${message.name}’s message`} from ${timeLabel(message.at)}`}
        checked={isOn}
        onClick={(event) => event.stopPropagation()}
        onChange={() => togglePick(message)}
      />
    ),
  };
}

/** The quote of the message `message` replies to, above its text; nothing for a message that isn't a reply. */
const Quote: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { targetOf, goTo, unavailable, selecting } = useThread();
  const { reply } = message;
  if (!reply || message.deleted) return null;
  return (
    <ReplyQuote
      target={targetOf(reply)}
      unavailable={unavailable.has(refKey(reply))}
      onGo={selecting ? null : () => goTo(reply)}
    />
  );
};

/** One message: the user's own on the right, everyone else's under a who-line (decision 9). */
const MessageRow: React.FC = () => {
  const { circle, editing, onPerson, channelMentions, selecting, highlighted } = useThread();
  const message = useAuiState((s) => circleOf(s.message));
  const previous = useAuiState((s) => circleOf(s.thread.messages[s.message.index - 1]));
  const pick = usePick(message);
  if (!message) return null;
  const sameDay = previous && new Date(previous.at).toDateString() === new Date(message.at).toDateString();
  const grouped =
    previous &&
    sameDay &&
    previous.author === message.author &&
    Boolean(previous.agent) === Boolean(message.agent) &&
    message.at - previous.at < GROUP_MS;
  const left = !message.agent && !circle.members.some((member) => member.identity === message.author);
  const pending =
    (message.confirmed ? '' : ' is-pending') +
    (!message.mine && mentionsUser(circle, message, channelMentions) ? ' is-mentioned' : '') +
    (highlighted === refKey(message) ? ' is-highlighted' : '');
  if (message.mine && !message.agent) {
    return (
      <MessagePrimitive.Root data-message={`${message.author}/${message.id}`} className={`wb-msg is-user wb-circle-msg${grouped ? ' is-cont' : ''}${pending}`}>
        <DayDivider />
        <div className={`wb-circle-line${pick.on}`} {...pick.line}>
          {pick.box}
          {/* A shared message is its own card, not a bubble (Circle chats spec decision 14); the
              editor replaces the bubble rather than sitting inside its fill. */}
          <Bubble plain={(Boolean(message.shared) && !message.deleted) || editing === message.id} gone={Boolean(message.deleted)}>
            <Quote message={message} />
            <Body message={message} />
          </Bubble>
          <Stamp message={message} withTime />
          <Pills message={message} />
          <Actions message={message} />
        </div>
      </MessagePrimitive.Root>
    );
  }
  const name = message.agent ? `${message.name}’s ${message.agent.name}` : message.name;
  return (
    <MessagePrimitive.Root data-message={`${message.author}/${message.id}`} className={`wb-msg is-assistant wb-circle-msg${grouped ? ' is-cont' : ''}${pending}`}>
      <DayDivider />
      <div className={`wb-circle-line wb-circle-row${pick.on}`} {...pick.line}>
        {pick.box}
        {grouped ? <span className="wb-circle-gutter" aria-hidden="true" /> : <Avatar name={message.name} seed={message.author} />}
        <div className="wb-circle-m">
          {grouped ? null : (
            <div className="wb-who wb-circle-who">
              {onPerson && !message.agent && !left && !selecting ? (
                <button
                  type="button"
                  className="wb-circle-name"
                  title={`${message.name}’s details`}
                  onClick={() => onPerson(message.author)}
                >
                  {name}
                </button>
              ) : (
                <span className="wb-circle-name">{name}</span>
              )}
              {message.agent ? <span className="wb-circle-tag">Agent</span> : null}
              {left ? <span className="wb-circle-tag">Left</span> : null}
              <Time message={message} />
            </div>
          )}
          <Quote message={message} />
          <div className="wb-prose wb-circle-text">
            <div className="wb-circle-body">
              <Body message={message} />
            </div>
            <Stamp message={message} />
          </div>
          <Pills message={message} />
        </div>
        <Actions message={message} />
      </div>
    </MessagePrimitive.Root>
  );
};

const MESSAGE_COMPONENTS = { UserMessage: MessageRow, AssistantMessage: MessageRow };

/** What the thread asks of the composer. */
interface ComposerHandle {
  /** Starts a reply to `message` in the open channel's draft and focuses the text box. */
  reply: (message: CircleMessage) => void;
}

const Composer: React.FC<{
  circle: CircleSnapshot;
  channel: { id: string; name: string };
  chat: CircleChatView;
  compact: boolean;
  targetOf: ThreadContextValue['targetOf'];
  ref: React.Ref<ComposerHandle>;
}> = ({ circle, channel, chat, compact, targetOf, ref }) => {
  const draftKey = `${circle.key}/${channel.id}`;
  const { boxRef, text, setText, sending, setSending, error, setError } = useComposerDraft(draftKey);
  // The message each draft replies to, as it was when the reply started; the strip shows its
  // current record when the channel has it (ADR 0053 §6). Kept with the drafts, so it outlives
  // the thread across a channel switch.
  const [replies, setReply] = useRemembered(replyDrafts);
  const replying = replies[draftKey];
  const replyTarget = replying ? (targetOf(replying) ?? replying) : null;
  const cancelReply = () => setReply(draftKey, undefined);
  useImperativeHandle(
    ref,
    () => ({
      reply: (message) => {
        setReply(draftKey, message);
        boxRef.current?.focus();
      },
    }),
    [draftKey]
  );
  const people = circle.members.length;
  const locked = !circle.writable || circle.needsUpdate;
  const canSend = Boolean(text.trim()) && !sending && !locked;
  const mentions = useCircleMentions({
    circle,
    draftKey,
    text,
    setText,
    boxRef,
  });
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const reply = replying ? { author: replying.author, id: replying.id } : null;
    const failed = reply
      ? await chat.send(text, mentions.picked, mentions.channel, reply)
      : await chat.send(text, mentions.picked, mentions.channel);
    setSending(false);
    if (failed) setError(failed);
    else {
      setText('');
      if (reply) cancelReply();
      mentions.reset();
    }
  };
  return (
    <div className="wb-composer wb-circle-composer">
      {error ? (
        <p className="wb-circle-error" role="alert">
          {error}
        </p>
      ) : null}
      {mentions.open ? <MentionMenu items={mentions.items} index={mentions.index} onPick={mentions.pick} /> : null}
      <div className="wb-input-box">
        {replyTarget ? <ReplyStrip target={replyTarget} onCancel={cancelReply} /> : null}
        <textarea
          ref={boxRef}
          aria-label={`Message ${circle.name}`}
          rows={1}
          value={text}
          disabled={locked}
          placeholder={
            circle.needsUpdate
              ? 'This Circle needs a newer version of the app'
              : !circle.writable
                ? 'This Mac is still joining this Circle'
                : `Message ${circle.name} · ${people} ${people === 1 ? 'person' : 'people'}`
          }
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim()) chat.notifyTyping();
          }}
          onKeyDown={(event) => {
            if (mentions.onKeyDown(event)) return;
            composerKey(event, replying ? cancelReply : null, () => void send());
          }}
        />
        <div className="wb-circle-tools">
          <span className="wb-chip wb-circle-audience">
            <CirclesMark size={12} />
            {compact ? circle.name : `${circle.name} · ${channel.name}`}
          </span>
          <RunButton running={false} held={false} canSend={canSend} onSend={() => void send()} onStop={() => undefined} />
        </div>
      </div>
      <p className="wb-circle-hint">Everyone in {circle.name} gets a copy</p>
    </div>
  );
};

/** Takes the composer's place in select mode: the count, Cancel and Remove. */
const SelectBar: React.FC<{ count: number; onCancel: () => void; onRemove: () => void }> = ({ count, onCancel, onRemove }) => (
  <div className="wb-composer wb-circle-select-bar" role="group" aria-label="Remove messages">
    <span className="wb-circle-select-count" role="status">
      {count ? `${count} selected` : 'Select messages to remove'}
    </span>
    <Button variant="secondary" block type="button" onClick={onCancel}>
      Cancel
    </Button>
    <Button variant="danger" type="button" disabled={count === 0} onClick={onRemove}>
      Remove
    </Button>
  </div>
);

/** "Remove 3 messages?" and how many of them failed, for the select-mode dialog. */
const plural = (count: number): string => `${count} ${count === 1 ? 'message' : 'messages'}`;

export interface CircleThreadProps {
  circle: CircleSnapshot;
  channel: { id: string; name: string };
  chat: CircleChatView;
  /** The header's controls on the right, such as the panel button. Not shown when compact. */
  headerEnd?: React.ReactNode;
  /** Opens a person's details from their name in a who-line. */
  onPerson?: (identity: string) => void;
  /** Whether @channel counts as a mention of the user here (their notification setting for the Circle). */
  channelMentions?: boolean;
  /**
   * The layout for a narrow surface, from 320px, such as the desktop panel: a channel picker in
   * the header (when `channels` is given) and a composer that grows to five lines.
   */
  compact?: boolean;
  /** The Circle's channels, for the compact header's picker. */
  channels?: CircleChannel[];
  onOpenChannel?: (channelId: string) => void;
  /**
   * An admin is picking messages to remove (Circle chats spec decision 10). Ignored for a member.
   * The place turns it off on a channel change; the thread asks it to with `onStopSelecting`
   * after Cancel, Escape or a removal that fully succeeds.
   */
  selecting?: boolean;
  onStopSelecting?: () => void;
}

/**
 * A Circle channel: header, messages and composer, from props alone (Circle chats spec, the
 * public seam). It renders through assistant-ui like the Workbench thread and shares its message
 * and day divider styles, with none of the Hermes run state.
 */
export const CircleThread: React.FC<CircleThreadProps> = ({
  circle,
  channel,
  chat,
  headerEnd,
  onPerson,
  channelMentions = false,
  compact = false,
  channels,
  onOpenChannel,
  selecting: selectingAsked = false,
  onStopSelecting,
}) => {
  const selecting = selectingAsked && circle.myRole === 'admin';
  const doc = useOwnerDocument();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CircleMessage | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [reactError, setReactError] = useState<string | null>(null);
  const [picking, setPicking] = useState<CircleMessage | null>(null);
  const reactSeq = useRef(0);
  const composer = useRef<ComposerHandle>(null);
  const targetOf = useReplyTargets(circle.key, channel.id, chat.messages);
  // Going to a reply's original: the one being looked for, then the one highlighted. `n` makes a
  // second click on the same quote scroll and highlight again.
  const [seeking, setSeeking] = useState<CircleMessageRef | null>(null);
  const [highlight, setHighlight] = useState<{ key: string; n: number } | null>(null);
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(() => new Set());
  // While looking: how many messages were loaded when the last older page was asked for, and
  // whether that page is still loading. A page that adds nothing ends the search.
  const older = useRef<{ from: number | null; loading: boolean }>({ from: null, loading: false });
  const [olderLoads, setOlderLoads] = useState(0);
  const runtime = useTextRuntime(chat.messages, toThreadMessage, (text) => chat.send(text));

  const newest = chat.messages.at(-1);
  // A new reaction to the user's messages marks the channel read again (`seen`).
  useReadWhileFocused(newest, chat.markRead, chat.seen);
  useEffect(() => {
    setEditing(null);
    setPicking(null);
    reactSeq.current++;
    setReactError(null);
    setSeeking(null);
    setHighlight(null);
    setUnavailable(new Set());
  }, [circle.key, channel.id]);

  const { messages, more, loadOlder } = chat;
  // An update may bring an original that couldn't be reached, so each one lets its quote try again
  // (ADR 0053 §5). Declared before the search below, so a search that gives up on this update wins.
  useEffect(() => setUnavailable((was) => (was.size ? new Set() : was)), [messages]);
  // Load older pages until the original is among the messages, back to the channel's first
  // message at most (ADR 0053 §7). If it never turns up, its quotes say it is not available.
  useEffect(() => {
    if (!seeking) return;
    const key = refKey(seeking);
    if (messages.some((item) => refKey(item) === key)) {
      setSeeking(null);
      setHighlight((was) => ({ key, n: (was?.n ?? 0) + 1 }));
      return;
    }
    if (older.current.loading) return;
    const stalled = older.current.from !== null && messages.length <= older.current.from;
    if (!more || stalled) {
      setSeeking(null);
      setUnavailable((was) => new Set(was).add(key));
      return;
    }
    older.current = { from: messages.length, loading: true };
    void loadOlder().finally(() => {
      older.current.loading = false;
      setOlderLoads((n) => n + 1);
    });
  }, [seeking, messages, more, loadOlder, olderLoads]);

  // Scroll to the original once its row is rendered, and drop the highlight after two seconds.
  useEffect(() => {
    if (!highlight) return;
    const stop = whenRow(doc, `[data-message="${highlight.key}"]`, (row) => row.scrollIntoView({ block: 'center' }));
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [highlight, doc]);
  // Picks belong to one round of select mode in one channel.
  useEffect(() => {
    setPicked(new Set());
    setConfirmingRemove(false);
    setRemoveError(null);
    if (selecting) {
      setEditing(null);
      setPicking(null);
    }
  }, [selecting, circle.key, channel.id]);
  // Escape leaves select mode, unless the dialog is open: it closes on Escape itself.
  useEffect(() => {
    if (!selecting || confirmingRemove) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onStopSelecting?.();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [selecting, confirmingRemove, onStopSelecting, doc]);

  // A clicked notification scrolls to its message once the channel has loaded. A message that is
  // not among the loaded ones is dropped: the channel is open on its newest. The runtime renders
  // rows a beat after the messages arrive, so a row that is not there yet is waited for.
  const focusVersion = useMessageFocusVersion();
  // Taken from the store once, then kept here until the row is scrolled to: a live message can
  // re-run the effect before the row exists.
  const pendingFocus = useRef<{ key: string; channel: string; ref: CircleMessageRef } | null>(null);
  useEffect(() => {
    if (pendingFocus.current && (pendingFocus.current.key !== circle.key || pendingFocus.current.channel !== channel.id)) {
      pendingFocus.current = null;
    }
    // After a channel change the hook still holds the old channel's messages for one render.
    if (chat.loading || chat.messages.some((item) => item.channel !== channel.id)) return;
    if (!pendingFocus.current) {
      const taken = takeMessageFocus(circle.key, channel.id);
      if (taken) pendingFocus.current = { key: circle.key, channel: channel.id, ref: taken };
    }
    const ref = pendingFocus.current?.ref;
    if (!ref) return;
    if (!chat.messages.some((item) => item.author === ref.author && item.id === ref.id)) {
      pendingFocus.current = null;
      return;
    }
    return whenRow(doc, `[data-message="${ref.author}/${ref.id}"]`, (row) => {
      row.scrollIntoView({ block: 'center' });
      pendingFocus.current = null;
    });
  }, [focusVersion, chat.loading, chat.messages, circle.key, channel.id, doc]);

  const goneRef = useRef(chat.goneCount);
  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (chat.goneCount > goneRef.current) setGoneNotice(true);
    goneRef.current = chat.goneCount;
  }, [chat.goneCount]);

  const context = useMemo<ThreadContextValue>(
    () => ({
      circle,
      editing,
      setEditing,
      onEdit: (message, text, picked, channel) => chat.edit(message.id, text, picked, channel),
      onDelete: (message) => {
        setDeleteError(null);
        setDeleting(message);
      },
      onReact: (message, emoji, on) => {
        // Only the newest click, in the channel it was made in, may set or clear the error.
        const mine = ++reactSeq.current;
        setReactError(null);
        const settle = (error: string | null): void => {
          if (reactSeq.current === mine) setReactError(error);
        };
        chat.react({ author: message.author, id: message.id }, emoji, on).then(settle, (cause: unknown) =>
          settle(cause instanceof Error && cause.message ? cause.message : 'Couldn’t update that reaction.')
        );
      },
      onMoreEmoji: setPicking,
      onPerson,
      channelMentions,
      selecting,
      picked,
      togglePick: (message) =>
        setPicked((was) => {
          const next = new Set(was);
          const key = refKey(message);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
      onReply: (message) => composer.current?.reply(message),
      targetOf,
      goTo: (ref) => {
        older.current = { from: null, loading: older.current.loading };
        setSeeking(ref);
      },
      highlighted: highlight?.key ?? null,
      unavailable,
    }),
    [circle, editing, chat, onPerson, channelMentions, selecting, picked, targetOf, highlight, unavailable]
  );
  // A picked message someone else removed meanwhile drops out of the count.
  const pickedMessages = chat.messages.filter((message) => !message.deleted && picked.has(refKey(message)));

  const unconfirmed = chat.messages.some((message) => !message.confirmed);
  const typing = typingLine(
    circle.members.filter((member) => !member.isMe && chat.typing.includes(member.identity)).map((member) => member.name)
  );
  const adminOnline = circle.members.some((member) => member.role === 'admin' && member.online);

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    const failed = await chat.remove({ author: deleting.author, id: deleting.id });
    setDeleteBusy(false);
    if (failed) setDeleteError(failed);
    else setDeleting(null);
  };

  // One at a time, so a failure names how many went through. Failed ones stay picked to retry.
  const confirmRemove = async () => {
    const targets = pickedMessages;
    setRemoveBusy(true);
    setRemoveError(null);
    const failed: { key: string; error: string }[] = [];
    for (const message of targets) {
      const error = await chat.remove({ author: message.author, id: message.id });
      if (error) failed.push({ key: refKey(message), error });
    }
    setRemoveBusy(false);
    if (failed.length === 0) {
      setConfirmingRemove(false);
      onStopSelecting?.();
      return;
    }
    setPicked(new Set(failed.map((item) => item.key)));
    setRemoveError(`${failed.length} of ${targets.length} wasn’t removed: ${failed[0].error}`);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadContext.Provider value={context}>
        <ThreadPrimitive.Root
          className={`wb-circle-thread${compact ? ' is-compact' : ''}${selecting ? ' is-selecting' : ''} relative flex h-full min-h-0 flex-col`}
          aria-label="Circle channel"
        >
          <div className="wb-thread-head">
            <div className="wb-thread-id">
              <CirclesMark size={18} />
              <span className="wb-thread-id-copy">
                <strong>
                  {circle.name} <span className="wb-circle-channel">· {channel.name}</span>
                </strong>
                <span className="wb-thread-kind">{compact ? peopleLine(circle) : `Circle channel · ${peopleLine(circle)}`}</span>
              </span>
            </div>
            <span className="wb-grow" aria-hidden="true" />
            {compact ? (
              channels && onOpenChannel ? (
                <select
                  className="wb-circle-pick"
                  aria-label="Channel"
                  value={channel.id}
                  onChange={(event) => onOpenChannel(event.target.value)}
                >
                  {channels.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.unread && item.id !== channel.id ? ` (${item.unread})` : ''}
                    </option>
                  ))}
                </select>
              ) : null
            ) : (
              headerEnd
            )}
          </div>

          <ThreadLog
            more={chat.more}
            onLoadOlder={chat.loadOlder}
            empty={
              !chat.loading && chat.messages.length === 0 ? (
                <>
                  <CirclesMark size={28} />
                  <h2>This is the start of {channel.name}</h2>
                  <p>Everyone in {circle.name} can read it. Messages stay on members’ Macs, not on a server.</p>
                </>
              ) : null
            }
          >
            <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
            <SeenBy circle={circle} chat={chat} />
          </ThreadLog>

          {chat.error ? (
            <p className="wb-circle-status is-warn" role="alert">
              {chat.error}
            </p>
          ) : reactError ? (
            <p className="wb-circle-status is-warn" role="alert">
              {reactError}
              <button type="button" className="wb-act" onClick={() => setReactError(null)}>
                Dismiss
              </button>
            </p>
          ) : unconfirmed && !adminOnline ? (
            <p className="wb-circle-status is-warn" role="status">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <circle cx="6" cy="6" r="4.75" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 3.6V6l1.6 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              No admin is online. New messages show now and settle in order once one is.
            </p>
          ) : typing ? (
            <p className="wb-circle-status is-typing" role="status">
              <span className="wb-circle-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {typing}
            </p>
          ) : goneNotice ? (
            <p className="wb-circle-status" role="status">
              A message from someone no longer in this Circle was dropped when the order settled.
              <button type="button" className="wb-act" onClick={() => setGoneNotice(false)}>
                Dismiss
              </button>
            </p>
          ) : null}

          {selecting ? (
            <SelectBar
              count={pickedMessages.length}
              onCancel={() => onStopSelecting?.()}
              onRemove={() => {
                setRemoveError(null);
                setConfirmingRemove(true);
              }}
            />
          ) : (
            <Composer ref={composer} circle={circle} channel={channel} chat={chat} compact={compact} targetOf={targetOf} />
          )}
        </ThreadPrimitive.Root>

        {picking ? (
          <MoreEmojiSheet
            onClose={() => setPicking(null)}
            onPick={(emoji) => {
              // Matches the quick picks: an emoji the user already has is taken back. The message is
              // read as it is now, since reactions may have changed while the picker was open.
              const target = picking;
              setPicking(null);
              if (!isReactionEmoji(emoji)) return;
              const current = chat.messages.find((m) => m.author === target.author && m.id === target.id) ?? target;
              context.onReact(target, emoji, !current.reactions.some((r) => r.emoji === emoji && r.mine));
            }}
          />
        ) : null}

        <DeleteSheet
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          busy={deleteBusy}
          titleId="circle-delete-message"
          title="Delete this message?"
          error={deleteError}
          onConfirm={() => void confirmDelete()}
        >
          It disappears from the chat. Every member’s Mac still holds the Circle’s history, so it isn’t erased.
        </DeleteSheet>

        <Sheet
          open={confirmingRemove}
          onClose={() => setConfirmingRemove(false)}
          busy={removeBusy}
          titleId="circle-remove-messages"
          title={`Remove ${plural(pickedMessages.length)}?`}
          error={removeError}
          actions={
            <SheetConfirmActions
              busy={removeBusy}
              tone="danger"
              confirmLabel={removeBusy ? 'Removing…' : 'Remove'}
              onCancel={() => setConfirmingRemove(false)}
              onConfirm={() => void confirmRemove()}
            />
          }
        >
          <p className="wb-sheet-help">
            They disappear from the chat for everyone and read “Removed by an admin”. Every member’s Mac still holds the
            Circle’s history, so they aren’t erased.
          </p>
        </Sheet>
      </ThreadContext.Provider>
    </AssistantRuntimeProvider>
  );
};
