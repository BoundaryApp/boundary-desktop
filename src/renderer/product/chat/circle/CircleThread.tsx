import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useAuiState } from '@assistant-ui/store';
import { Streamdown } from 'streamdown';
import type { CircleChannel, CircleMessage, CircleSnapshot } from '../../../../shared/types/circles';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { Avatar } from '../../circles/CircleControls';
import type { CircleChatView } from '../../circles/useCircleChat';
import { DayDivider } from '../MessageActions';
import { RunButton } from '../RunButton';
import { CirclesMark } from './CirclesMark';
import { peopleLine } from './peopleLine';
import './circleChat.css';

/** Messages from one person this close together share a who-line. */
const GROUP_MS = 5 * 60_000;
/** A message never loads anything from the network when it renders (Circle chats spec decision 11). */
const NO_IMAGES = ['img'];

/** The composer grows to this many lines, then scrolls. */
const COMPOSER_LINES = 5;

const UNCONFIRMED_TIP = 'Waiting for admins to confirm. Its place in the chat can still change.';

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
  compact: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onEdit: (message: CircleMessage, text: string) => Promise<string | null>;
  onDelete: (message: CircleMessage) => void;
}

const ThreadContext = createContext<ThreadContextValue | null>(null);

function useThread(): ThreadContextValue {
  const value = useContext(ThreadContext);
  if (!value) throw new Error('CircleThread parts need CircleThread.');
  return value;
}

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

const EditBox: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { setEditing, onEdit } = useThread();
  const [text, setText] = useState(message.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!text.trim() || busy) return;
    if (text === message.text) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const failed = await onEdit(message, text);
    setBusy(false);
    if (failed) setError(failed);
    else setEditing(null);
  };
  return (
    <div className="wb-circle-edit">
      <textarea
        aria-label="Edit message"
        value={text}
        rows={2}
        autoFocus
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(null);
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {error ? (
        <p className="wb-circle-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-circle-edit-row">
        <span>Esc to cancel · Enter to save</span>
        <button type="button" className="wb-btn-ghost" onClick={() => setEditing(null)}>
          Cancel
        </button>
        <button type="button" className="wb-btn-solid" disabled={busy || !text.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
    </div>
  );
};

const Body: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { editing } = useThread();
  if (message.deleted) {
    return <p className="wb-circle-gone">{message.deleted === 'admin' ? 'Removed by an admin' : 'Deleted'}</p>;
  }
  if (editing === message.id && message.mine) return <EditBox message={message} />;
  const text = message.text ? (
    <Streamdown className="wb-streamdown" skipHtml disallowedElements={NO_IMAGES}>
      {message.text}
    </Streamdown>
  ) : null;
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
      </div>
    );
  }
  return (
    <>
      {message.call ? <p className="wb-circle-call">{callLine(message)}</p> : null}
      {text}
    </>
  );
};

const Actions: React.FC<{ message: CircleMessage }> = ({ message }) => {
  const { circle, compact, editing, setEditing, onDelete } = useThread();
  const [open, setOpen] = useState(false);
  if (message.deleted || editing === message.id) return null;
  const canEdit = message.mine && !message.agent && !message.shared;
  const canDelete = message.mine || circle.myRole === 'admin';
  // Compact: the row sits behind …, since there's no room to show it on hover.
  if (compact && !open) {
    return (
      <div className="wb-acts wb-circle-more">
        <button type="button" className="wb-act" aria-label="Message actions" aria-expanded={false} onClick={() => setOpen(true)}>
          …
        </button>
      </div>
    );
  }
  return (
    <ActionBarPrimitive.Root
      className={`wb-acts${compact ? ' wb-circle-more is-open' : ''}`}
      onBlur={(event) => {
        if (compact && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <ActionBarPrimitive.Copy className="wb-act" copiedDuration={1400} aria-label="Copy">
        Copy
      </ActionBarPrimitive.Copy>
      {canEdit ? (
        <button type="button" className="wb-act" onClick={() => setEditing(message.id)}>
          Edit
        </button>
      ) : null}
      {canDelete ? (
        <button type="button" className="wb-act" onClick={() => onDelete(message)}>
          Delete
        </button>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

/** One message: the user's own on the right, everyone else's under a who-line (decision 9). */
const MessageRow: React.FC = () => {
  const { circle } = useThread();
  const message = useAuiState((s) => circleOf(s.message));
  const previous = useAuiState((s) => circleOf(s.thread.messages[s.message.index - 1]));
  if (!message) return null;
  const sameDay = previous && new Date(previous.at).toDateString() === new Date(message.at).toDateString();
  const grouped =
    previous &&
    sameDay &&
    previous.author === message.author &&
    Boolean(previous.agent) === Boolean(message.agent) &&
    message.at - previous.at < GROUP_MS;
  const left = !message.agent && !circle.members.some((member) => member.identity === message.author);
  const pending = message.confirmed ? '' : ' is-pending';
  if (message.mine && !message.agent) {
    return (
      <MessagePrimitive.Root className={`wb-msg is-user wb-circle-msg${grouped ? ' is-cont' : ''}${pending}`}>
        <DayDivider />
        {/* A shared message is its own card, not a bubble (Circle chats spec decision 14). */}
        {message.shared && !message.deleted ? (
          <Body message={message} />
        ) : (
          <div className="wb-bubble">
            <Body message={message} />
          </div>
        )}
        <Stamp message={message} withTime />
        <Actions message={message} />
      </MessagePrimitive.Root>
    );
  }
  const name = message.agent ? `${message.name}’s ${message.agent.name}` : message.name;
  return (
    <MessagePrimitive.Root className={`wb-msg is-assistant wb-circle-msg${grouped ? ' is-cont' : ''}${pending}`}>
      <DayDivider />
      <div className="wb-circle-row">
        {grouped ? <span className="wb-circle-gutter" aria-hidden="true" /> : <Avatar name={message.name} seed={message.author} />}
        <div className="wb-circle-m">
          {grouped ? null : (
            <div className="wb-who wb-circle-who">
              <span className="wb-circle-name">{name}</span>
              {message.agent ? <span className="wb-circle-tag">Agent</span> : null}
              {left ? <span className="wb-circle-tag">Left</span> : null}
              <Time message={message} />
            </div>
          )}
          <div className="wb-prose wb-circle-text">
            <div className="wb-circle-body">
              <Body message={message} />
            </div>
            <Stamp message={message} />
          </div>
        </div>
      </div>
      <Actions message={message} />
    </MessagePrimitive.Root>
  );
};

const MESSAGE_COMPONENTS = { UserMessage: MessageRow, AssistantMessage: MessageRow };

const Composer: React.FC<{
  circle: CircleSnapshot;
  channel: { id: string; name: string };
  chat: CircleChatView;
  compact: boolean;
}> = ({ circle, channel, chat, compact }) => {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftKey = `${circle.key}/${channel.id}`;
  const text = drafts[draftKey] ?? '';
  const people = circle.members.length;
  const locked = !circle.writable || circle.needsUpdate;
  const canSend = Boolean(text.trim()) && !sending && !locked;
  // Grow with the text up to five lines, then scroll.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const style = getComputedStyle(box);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, line * COMPOSER_LINES + padding)}px`;
  }, [text]);
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const failed = await chat.send(text);
    setSending(false);
    if (failed) setError(failed);
    else setDrafts((all) => ({ ...all, [draftKey]: '' }));
  };
  return (
    <div className="wb-composer wb-circle-composer">
      {error ? (
        <p className="wb-circle-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-input-box">
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
            setDrafts((all) => ({ ...all, [draftKey]: event.target.value }));
            if (event.target.value.trim()) chat.notifyTyping();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
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
      {compact ? null : <p className="wb-circle-hint">Everyone in {circle.name} gets a copy</p>}
    </div>
  );
};

export interface CircleThreadProps {
  circle: CircleSnapshot;
  channel: { id: string; name: string };
  chat: CircleChatView;
  /** The header's controls on the right, such as the panel button. Not shown when compact. */
  headerEnd?: React.ReactNode;
  /**
   * The layout for a narrow dock, from 320px: a channel picker in the header (when `channels` is
   * given), actions behind …, no hint, and a composer that grows to five lines.
   */
  compact?: boolean;
  /** The Circle's channels, for the compact header's picker. */
  channels?: CircleChannel[];
  onOpenChannel?: (channelId: string) => void;
}

/**
 * A Circle channel: header, messages and composer, from props alone (Circle chats spec, the
 * public seam). It renders through assistant-ui like the Workbench thread and shares its message,
 * day divider and hover-row styles, with none of the Hermes run state.
 */
export const CircleThread: React.FC<CircleThreadProps> = ({
  circle,
  channel,
  chat,
  headerEnd,
  compact = false,
  channels,
  onOpenChannel,
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CircleMessage | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const runtime = useExternalStoreRuntime<CircleMessage>({
    messages: chat.messages,
    convertMessage: toThreadMessage,
    isRunning: false,
    onNew: async (message) => {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const failed = await chat.send(text);
      if (failed) throw new Error(failed);
    },
  });

  const newest = chat.messages.at(-1);
  const { markRead } = chat;
  useEffect(() => {
    if (newest && document.visibilityState === 'visible') markRead(newest);
  }, [newest, markRead]);
  useEffect(() => setEditing(null), [circle.key, channel.id]);

  const goneRef = useRef(chat.goneCount);
  const [goneNotice, setGoneNotice] = useState(false);
  useEffect(() => {
    if (chat.goneCount > goneRef.current) setGoneNotice(true);
    goneRef.current = chat.goneCount;
  }, [chat.goneCount]);

  const context = useMemo<ThreadContextValue>(
    () => ({
      circle,
      compact,
      editing,
      setEditing,
      onEdit: (message, text) => chat.edit(message.id, text),
      onDelete: (message) => {
        setDeleteError(null);
        setDeleting(message);
      },
    }),
    [circle, compact, editing, chat]
  );

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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadContext.Provider value={context}>
        <ThreadPrimitive.Root
          className={`wb-circle-thread${compact ? ' is-compact' : ''} relative flex h-full min-h-0 flex-col`}
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

          <ThreadPrimitive.Viewport className="wb-log wb-circle-log" role="log" aria-label="Messages">
            {chat.more ? (
              <button type="button" className="wb-btn-ghost wb-circle-older" onClick={() => void chat.loadOlder()}>
                Show earlier messages
              </button>
            ) : null}
            {!chat.loading && chat.messages.length === 0 ? (
              <div className="wb-circle-empty">
                <CirclesMark size={28} />
                <h2>This is the start of {channel.name}</h2>
                <p>Everyone in {circle.name} can read it. Messages stay on members’ Macs, not on a server.</p>
              </div>
            ) : null}
            <ThreadPrimitive.Messages components={MESSAGE_COMPONENTS} />
            <SeenBy circle={circle} chat={chat} />
          </ThreadPrimitive.Viewport>

          {chat.error ? (
            <p className="wb-circle-status is-warn" role="alert">
              {chat.error}
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

          <Composer circle={circle} channel={channel} chat={chat} compact={compact} />
        </ThreadPrimitive.Root>

        <Sheet
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          busy={deleteBusy}
          titleId="circle-delete-message"
          title="Delete this message?"
          error={deleteError}
          actions={
            <SheetConfirmActions
              busy={deleteBusy}
              tone="danger"
              confirmLabel={deleteBusy ? 'Deleting…' : 'Delete'}
              onCancel={() => setDeleting(null)}
              onConfirm={() => void confirmDelete()}
            />
          }
        >
          <p className="wb-sheet-help">
            It disappears from the chat. Every member’s Mac still holds the Circle’s history, so it isn’t erased.
          </p>
        </Sheet>
      </ThreadContext.Provider>
    </AssistantRuntimeProvider>
  );
};
