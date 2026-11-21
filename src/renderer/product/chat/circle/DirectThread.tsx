import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { useAuiState } from '@assistant-ui/store';
import { Streamdown } from 'streamdown';
import type { CircleMessageRef, CircleSnapshot, DirectMessage } from '../../../../shared/types/circles';
import { messageRowSelector, refKey, sameRef } from '../../../../shared/circleMessageRef';
import { Avatar } from '../../circles/CircleControls';
import { useOwnerDocument } from '../../../components/ui/ownerDocument';
import { MAX_DIRECT_TEXT_BYTES, directTextBytes } from '../../../../shared/circleDirect';
import type { DirectChatView } from '../../circles/useDirectChat';
import { directSlot, takeMessageFocus, useMessageFocusVersion } from '../../circles/circlesNavigation';
import { CopyAction, DayDivider, EditIcon, Icon } from '../MessageActions';
import { RunButton } from '../RunButton';
import {
  Bubble,
  composerKey,
  DeleteIcon,
  DeleteSheet,
  EditBox,
  ThreadLog,
  rememberedStore,
  useComposerDraft,
  useReadWhileFocused,
  useRemembered,
  useTextRuntime,
} from './threadParts';
import { CIRCLE_LINK_SAFETY } from './LinkConfirmSheet';
import { Button } from '../../../components/ui/button';
import { ReplyQuote, ReplyStrip } from './ReplyQuote';
import { Textarea } from '../../../components/ui/textarea';
import './circleChat.css';
import './direct.css';

/** Messages from one person this close together share a who-line, as in channels. */
const GROUP_MS = 5 * 60_000;
/** A message never loads anything from the network when it renders. */
const NO_IMAGES = ['img'];
/** The byte countdown shows once this little is left. */
const COUNTDOWN_FROM = 512;
/** How long a quoted message stays highlighted after jumping to it (ADR 0053 §7). */
const HIGHLIGHT_MS = 2_000;

const LockMark: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg className="wb-direct-lock" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);


/** The message each conversation's composer is replying to, kept across switching away. */
const replyTargets = rememberedStore<CircleMessageRef>();

/** The time as ISO 8601, or undefined for one a Date can't hold (main drops those; older files may keep one). */
function isoTime(at: number): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** What a message of the user's says about delivery (ADR 0054 §7). */
function deliveryLine(message: DirectMessage, name: string): string | null {
  switch (message.delivery) {
    case 'waiting':
      return `Waiting for ${name} to come online`;
    case 'sending':
      return 'Sending…';
    case 'delivered':
      return 'Delivered';
    case 'undelivered':
      return 'Not delivered';
    default:
      return null;
  }
}

const WAITING_TIP = 'Kept on this Mac until their Mac connects. If they are online and this doesn’t change, they may need to update.';

interface ContextValue {
  name: string;
  ended: boolean;
  messages: DirectMessage[];
  /** The user's newest message, the one that says Delivered. */
  newestMine: DirectMessage | undefined;
  editing: string | null;
  setEditing: (id: string | null) => void;
  onEdit: (message: DirectMessage, text: string) => Promise<string | null>;
  onDelete: (message: DirectMessage) => void;
  onReply: (message: DirectMessage) => void;
  onGoTo: (ref: CircleMessageRef) => void;
  highlight: string | null;
}

const Context = createContext<ContextValue | null>(null);

function useDirect(): ContextValue {
  const value = useContext(Context);
  if (!value) throw new Error('DirectThread parts need DirectThread.');
  return value;
}

const directOf = (message: { metadata?: { custom?: Record<string, unknown> } } | undefined): DirectMessage | null =>
  (message?.metadata?.custom?.direct as DirectMessage | undefined) ?? null;

function toThreadMessage(message: DirectMessage): ThreadMessageLike {
  return {
    id: refKey(message),
    role: message.mine ? 'user' : 'assistant',
    content: [{ type: 'text', text: message.text }],
    createdAt: new Date(message.at),
    metadata: { custom: { direct: message } },
  };
}

/** The quoted message above a reply: a link to it, or why it can't be shown. */
const Quote: React.FC<{ reply: CircleMessageRef }> = ({ reply }) => {
  const { messages, name, onGoTo } = useDirect();
  const target = messages.find((item) => sameRef(item, reply));
  return <ReplyQuote target={target ? { ...target, name } : null} unavailable={!target} onGo={() => onGoTo(reply)} />;
};

const MessageEditBox: React.FC<{ message: DirectMessage }> = ({ message }) => {
  const { setEditing, onEdit } = useDirect();
  return (
    <EditBox
      initial={message.text}
      onCancel={() => setEditing(null)}
      onSave={(text) => onEdit(message, text)}
      problem={(text) => (directTextBytes(text) > MAX_DIRECT_TEXT_BYTES ? 'That’s longer than a direct message can be.' : null)}
    />
  );
};

const Body: React.FC<{ message: DirectMessage }> = ({ message }) => {
  const { editing } = useDirect();
  const overlayRoot = useOwnerDocument().body;
  if (message.deleted) return <p className="wb-circle-gone">Deleted</p>;
  if (editing === message.id && message.mine) return <MessageEditBox message={message} />;
  return (
    <>
      {message.reply ? <Quote reply={message.reply} /> : null}
      <Streamdown className="wb-streamdown" portal={overlayRoot} skipHtml disallowedElements={NO_IMAGES} linkSafety={CIRCLE_LINK_SAFETY}>
        {message.text}
      </Streamdown>
    </>
  );
};

const ReplyIcon = () => (
  <Icon>
    <path d="M6.5 4L3 7.5 6.5 11" />
    <path d="M3.5 7.5H10a3 3 0 0 1 3 3V12" />
  </Icon>
);

/** The hover toolbar (ADR 0054 §9): Copy and Reply, and Edit and Delete on the user's own. */
const Actions: React.FC<{ message: DirectMessage }> = ({ message }) => {
  const { editing, ended, setEditing, onDelete, onReply } = useDirect();
  if (message.deleted || editing === message.id) return null;
  return (
    <ActionBarPrimitive.Root className="wb-circle-bar" role="toolbar" aria-label="Message actions">
      <CopyAction />
      {ended ? null : (
        <Button type="button" variant="quiet" size="icon-xs" aria-label="Reply" title="Reply" onClick={() => onReply(message)}>
          <ReplyIcon />
        </Button>
      )}
      {message.mine && !ended ? (
        <>
          <Button type="button" variant="quiet" size="icon-xs" aria-label="Edit" title="Edit" onClick={() => setEditing(message.id)}>
            <EditIcon />
          </Button>
          <Button type="button" variant="quiet" size="icon-xs" aria-label="Delete" title="Delete" onClick={() => onDelete(message)}>
            <DeleteIcon />
          </Button>
        </>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

const MessageRow: React.FC = () => {
  const { name, ended, newestMine, editing, highlight } = useDirect();
  const message = useAuiState((s) => directOf(s.message));
  const previous = useAuiState((s) => directOf(s.thread.messages[s.message.index - 1]));
  if (!message) return null;
  const key = refKey(message);
  const lit = highlight === key ? ' is-highlighted' : '';
  const sameDay = previous && new Date(previous.at).toDateString() === new Date(message.at).toDateString();
  const grouped = previous && sameDay && previous.author === message.author && message.at - previous.at < GROUP_MS;
  const time = (
    <time className="wb-circle-time" dateTime={isoTime(message.at)}>
      {timeLabel(message.at)}
    </time>
  );
  if (message.mine) {
    // Delivered shows on the newest message only; anything still on its way says so on each.
    const delivery = message.delivery === 'delivered' && message !== newestMine ? null : deliveryLine(message, name);
    const waiting = message.delivery === 'waiting' || message.delivery === 'sending' ? ' is-waiting' : '';
    return (
      <MessagePrimitive.Root data-message={key} className={`wb-msg is-user wb-circle-msg wb-direct-msg${grouped ? ' is-cont' : ''}${waiting}${lit}`}>
        <DayDivider />
        <div className="wb-circle-line">
          <Bubble plain={editing === message.id} gone={message.deleted}>
            <Body message={message} />
          </Bubble>
          <span className="wb-circle-stamp">
            {time}
            {message.edited && !message.deleted ? <span>edited</span> : null}
            {delivery && !message.deleted ? (
              <span className="wb-direct-delivery" title={message.delivery === 'waiting' ? WAITING_TIP : undefined}>
                {delivery}
              </span>
            ) : null}
          </span>
          <Actions message={message} />
        </div>
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root data-message={key} className={`wb-msg is-assistant wb-circle-msg wb-direct-msg${grouped ? ' is-cont' : ''}${lit}`}>
      <DayDivider />
      <div className="wb-circle-line wb-circle-row">
        {grouped ? <span className="wb-circle-gutter" aria-hidden="true" /> : <Avatar name={name} seed={message.author} />}
        <div className="wb-circle-m">
          {grouped ? null : (
            <div className="wb-who wb-circle-who">
              <span className="wb-circle-name">{name}</span>
              {ended ? <span className="wb-circle-tag">Left</span> : null}
              {time}
            </div>
          )}
          <div className="wb-prose wb-circle-text">
            <div className="wb-circle-body">
              <Body message={message} />
            </div>
            <span className="wb-circle-stamp">{message.edited && !message.deleted ? <span>edited</span> : null}</span>
          </div>
        </div>
        <Actions message={message} />
      </div>
    </MessagePrimitive.Root>
  );
};

const Composer: React.FC<{
  draftKey: string;
  name: string;
  circleName: string;
  chat: DirectChatView;
  replyTo: DirectMessage | null;
  onCancelReply: () => void;
  onSent: () => void;
  locked: boolean;
}> = ({ draftKey, name, circleName, chat, replyTo, onCancelReply, onSent, locked }) => {
  const { boxRef, text, setText, sending, setSending, error, setError } = useComposerDraft(draftKey);
  const left = MAX_DIRECT_TEXT_BYTES - directTextBytes(text);
  const canSend = Boolean(text.trim()) && !sending && !locked && left >= 0;
  // By message, not object: a reply target that is replaced (delivered, edited) mustn't take focus again.
  const replyKey = replyTo ? `${replyTo.author}/${replyTo.id}` : null;
  useEffect(() => {
    if (replyKey) boxRef.current?.focus();
  }, [replyKey]);
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const failed = await chat.send(text, replyTo ? { author: replyTo.author, id: replyTo.id } : undefined);
    setSending(false);
    if (failed) setError(failed);
    else {
      setText('');
      onSent();
    }
  };
  return (
    <div className="wb-composer wb-circle-composer wb-direct-composer">
      {error ? (
        <p className="wb-circle-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="wb-input-box">
        {replyTo ? (
          <ReplyStrip target={{ ...replyTo, name }} onCancel={onCancelReply} />
        ) : null}
        <Textarea
          variant="bare"
          className="wb-circle-composer-input"
          ref={boxRef}
          aria-label={`Message ${name}`}
          rows={1}
          value={text}
          disabled={locked}
          placeholder={locked ? 'This Mac is still joining this Circle' : `Message ${name} · only ${name} sees this`}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            if (value.trim()) chat.notifyTyping();
          }}
          onKeyDown={(event) => {
            composerKey(event, replyTo ? onCancelReply : null, () => void send());
          }}
        />
        <div className="wb-circle-tools">
          <span className="wb-chip wb-direct-audience">
            <LockMark size={12} />
            Only {name}
          </span>
          {left < COUNTDOWN_FROM ? (
            <span className={`wb-direct-bytes${left < 0 ? ' is-over' : ''}`} role="status">
              {left < 0 ? `${(-left).toLocaleString()} bytes over` : `${left.toLocaleString()} bytes left`}
            </span>
          ) : null}
          <RunButton running={false} held={false} canSend={canSend} onSend={() => void send()} onStop={() => undefined} />
        </div>
      </div>
      <p className="wb-circle-hint">Delivered when you’re both online. Nobody else in {circleName} sees it.</p>
    </div>
  );
};

/** Both roles render through one row, which reads the message's own fields. */
const DIRECT_COMPONENTS = { UserMessage: MessageRow, AssistantMessage: MessageRow };

export interface DirectThreadProps {
  circle: CircleSnapshot;
  /** The other person's identity. */
  peer: string;
  /** Their name, kept after they leave. */
  name: string;
  /** They left or were removed: the conversation is read-only. */
  ended: boolean;
  chat: DirectChatView;
  /** The header's controls on the right, such as the panel button. */
  headerEnd?: React.ReactNode;
}

/**
 * A direct conversation in a Circle (ADR 0054 §5–§9): the same message rows, day dividers and
 * hover toolbar as a channel, with a lock instead of the Circle mark, delivery lines instead of
 * the unconfirmed clock, and none of the channel's mentions, reactions, GIFs or sharing.
 */
export const DirectThread: React.FC<DirectThreadProps> = ({ circle, peer, name, ended, chat, headerEnd }) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DirectMessage | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replies, setReply] = useRemembered(replyTargets);
  const [highlight, setHighlight] = useState<string | null>(null);
  const draftKey = `${circle.key}/${peer}`;
  const member = circle.members.find((item) => item.identity === peer);
  const online = !ended && Boolean(member?.online);

  const runtime = useTextRuntime(chat.messages, toThreadMessage, (text) => chat.send(text));

  useEffect(() => {
    setEditing(null);
    setNotice(null);
    setHighlight(null);
  }, [draftKey]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  // A clicked notification names a message: once it is loaded, scroll to it and light it up.
  const focusVersion = useMessageFocusVersion();
  const doc = useOwnerDocument();
  const pendingFocus = useRef<CircleMessageRef | null>(null);
  useEffect(() => {
    if (chat.loading) return;
    pendingFocus.current = takeMessageFocus(circle.key, directSlot(peer)) ?? pendingFocus.current;
    const ref = pendingFocus.current;
    if (!ref) return;
    pendingFocus.current = null;
    if (chat.messages.some((item) => sameRef(item, ref))) setHighlight(refKey(ref));
  }, [focusVersion, chat.loading, chat.messages, circle.key, peer]);
  // The highlighted row may render a beat after the state that names it.
  useEffect(() => {
    if (!highlight) return;
    const selector = messageRowSelector(highlight);
    const row = doc.querySelector(selector);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      return;
    }
    const observer = new MutationObserver(() => {
      const found = doc.querySelector(selector);
      if (!found) return;
      found.scrollIntoView({ block: 'center' });
      observer.disconnect();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [highlight, doc]);

  const replyRef = replies[draftKey];
  const replyTo = replyRef ? (chat.messages.find((item) => sameRef(item, replyRef) && !item.deleted) ?? null) : null;
  const clearReply = (): void =>
    setReply(draftKey, undefined);

  const newestMine = [...chat.messages].reverse().find((item) => item.mine && !item.deleted);
  useReadWhileFocused(chat.messages.at(-1), chat.markRead);
  const context = useMemo<ContextValue>(
    () => ({
      name,
      ended,
      messages: chat.messages,
      newestMine,
      editing,
      setEditing,
      onEdit: (message, text) => chat.edit(message.id, text),
      onDelete: (message) => {
        setDeleteError(null);
        setDeleting(message);
      },
      onReply: (message) => setReply(draftKey, { author: message.author, id: message.id }),
      onGoTo: (ref) => setHighlight(refKey(ref)),
      highlight,
    }),
    [name, ended, chat, newestMine, editing, draftKey, highlight]
  );

  const neverSent = deleting?.neverSent === true;
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    const { error, unsent } = await chat.remove(deleting.id);
    setDeleteBusy(false);
    if (error) {
      setDeleteError(error);
      return;
    }
    if (replyRef && sameRef(replyRef, deleting)) clearReply();
    setDeleting(null);
    setNotice(unsent ? `Removed before ${name} received it.` : null);
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Context.Provider value={context}>
        <ThreadPrimitive.Root className="wb-circle-thread wb-direct-thread relative flex h-full min-h-0 flex-col" aria-label={`Direct messages with ${name}`}>
          <div className="wb-thread-head">
            <div className="wb-thread-id">
              <LockMark size={18} />
              <span className="wb-thread-id-copy">
                <strong>
                  {name} <span className="wb-circle-channel">· Direct message in {circle.name}</span>
                </strong>
                <span className="wb-thread-kind wb-direct-presence">
                  {ended ? (
                    <>
                      <span className="wb-circle-tag">Left</span> Left {circle.name}
                    </>
                  ) : (
                    <>
                      <i className={`wb-online-dot${online ? '' : ' is-off'}`} aria-hidden="true" />
                      {online ? 'Online' : 'Away'}
                    </>
                  )}
                </span>
              </span>
            </div>
            <span className="wb-grow" aria-hidden="true" />
            {headerEnd}
          </div>

          <ThreadLog
            more={chat.more}
            onLoadOlder={chat.loadOlder}
            empty={
              !chat.loading && chat.messages.length === 0 ? (
                <>
                  <LockMark size={28} />
                  <h2>This is the start of your conversation with {name}</h2>
                  <p>Only you and {name} see it. It stays on your two Macs and never enters {circle.name}’s history.</p>
                </>
              ) : null
            }
          >
            <ThreadPrimitive.Messages components={DIRECT_COMPONENTS} />
          </ThreadLog>

          {chat.error ? (
            <p className="wb-circle-status is-warn" role="alert">
              {chat.error}
            </p>
          ) : notice ? (
            <p className="wb-circle-status" role="status">
              {notice}
              <Button type="button" variant="quiet" size="sm" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </p>
          ) : chat.typing && !ended ? (
            <p className="wb-circle-status is-typing" role="status">
              <span className="wb-circle-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {name} is typing…
            </p>
          ) : null}

          {ended ? (
            <div className="wb-composer wb-direct-ended" role="note">
              {name} left {circle.name}. This conversation stays on this Mac, read-only, until you leave too.
            </div>
          ) : (
            <Composer
              draftKey={draftKey}
              name={name}
              circleName={circle.name}
              chat={chat}
              replyTo={replyTo}
              onCancelReply={clearReply}
              onSent={clearReply}
              locked={!circle.writable}
            />
          )}
        </ThreadPrimitive.Root>

        <DeleteSheet
          open={deleting !== null}
          onClose={() => setDeleting(null)}
          busy={deleteBusy}
          titleId="direct-delete-message"
          title={neverSent ? 'Delete before it’s sent?' : 'Delete this message?'}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
        >
          {neverSent
            ? 'It hasn’t left this Mac, so it is removed and never sent.'
            : `It disappears from ${name}’s Mac the next time you’re both online. Anything ${name} copied stays with ${name}.`}
        </DeleteSheet>
      </Context.Provider>
    </AssistantRuntimeProvider>
  );
};
