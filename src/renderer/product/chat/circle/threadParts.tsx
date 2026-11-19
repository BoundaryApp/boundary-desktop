import React, { useEffect, useRef, useState } from 'react';
import {
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { Sheet, SheetConfirmActions } from '../../../components/ui/sheet';
import { useOwnerDocument } from '../../../components/ui/ownerDocument';
import { Icon } from '../MessageActions';
import { Button } from '../../../components/ui/button';

/**
 * Pieces a Circle channel and a direct conversation share: the edit box, the delete icon and
 * dialog, the composer's draft and growing box, the runtime, and the earlier-messages button.
 */

/** The composer grows to this many lines, then scrolls. */
const COMPOSER_LINES = 5;

export const DeleteIcon = () => (
  <Icon>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </Icon>
);

/**
 * A message's text being edited in place. `problem` blocks saving and says why; `onSave` resolves
 * to an error, or null once saved. Saving unchanged text just closes the box.
 */
export const EditBox: React.FC<{
  initial: string;
  onSave: (text: string) => Promise<string | null>;
  onCancel: () => void;
  problem?: (text: string) => string | null;
}> = ({ initial, onSave, onCancel, problem }) => {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = problem?.(text) ?? null;
  const save = async () => {
    if (!text.trim() || busy || blocked) return;
    if (text === initial) {
      onCancel();
      return;
    }
    setBusy(true);
    const failed = await onSave(text);
    setBusy(false);
    if (failed) setError(failed);
    else onCancel();
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
          if (event.key === 'Escape') {
            // Claimed, so a surface around the thread (the desktop panel) doesn't close too.
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
        }}
      />
      {blocked || error ? (
        <p className="wb-circle-error" role="alert">
          {blocked ?? error}
        </p>
      ) : null}
      <div className="wb-circle-edit-row">
        <span>Esc to cancel · Enter to save</span>
        <Button variant="secondary" block type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" block type="button" disabled={busy || !text.trim() || Boolean(blocked)} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
};

/** The user's own message: in a bubble, unless `plain` (an editor or a card) stands alone. */
export const Bubble: React.FC<{ plain: boolean; gone: boolean; children: React.ReactNode }> = ({ plain, gone, children }) =>
  plain ? <>{children}</> : <div className={`wb-bubble${gone ? ' is-gone' : ''}`}>{children}</div>;

/**
 * Values by conversation that outlive the thread showing them, for this page only: moving
 * between a channel, a direct conversation and a folder unmounts one thread and mounts another,
 * and every view of the same conversation shows the same value.
 */
/** Every mounted view of a store, so a channel open in the panel and the Circles screen shows one draft. */
const storeListeners = new WeakMap<Map<string, unknown>, Set<() => void>>();

export function useRemembered<T>(store: Map<string, T>): [Record<string, T>, (key: string, value: T | undefined) => void] {
  const [values, setValues] = useState<Record<string, T>>(() => Object.fromEntries(store));
  useEffect(() => {
    const key = store as Map<string, unknown>;
    const listeners = storeListeners.get(key) ?? new Set<() => void>();
    storeListeners.set(key, listeners);
    const listener = (): void => setValues(Object.fromEntries(store));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [store]);
  const set = (key: string, value: T | undefined): void => {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
    for (const listener of [...(storeListeners.get(store as Map<string, unknown>) ?? [])]) listener();
  };
  return [values, set];
}

const rememberedStores: Map<string, unknown>[] = [];

/** A store for `useRemembered`, emptied by `resetRememberedForTests`. */
export function rememberedStore<T>(): Map<string, T> {
  const store = new Map<string, T>();
  rememberedStores.push(store as Map<string, unknown>);
  return store;
}

/** For tests: forget remembered drafts and reply targets. */
export function resetRememberedForTests(): void {
  for (const store of rememberedStores) store.clear();
}

const drafts = rememberedStore<string>();

/**
 * A composer's draft for each conversation, kept while the user moves between them, with a box
 * that grows with the text up to five lines, then scrolls.
 */
export function useComposerDraft(draftKey: string) {
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [saved, save] = useRemembered(drafts);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = saved[draftKey] ?? '';
  const setText = (value: string): void => save(draftKey, value || undefined);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const style = (box.ownerDocument.defaultView ?? window).getComputedStyle(box);
    const line = parseFloat(style.lineHeight) || 20;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, line * COMPOSER_LINES + padding)}px`;
  }, [text]);
  return { boxRef, text, setText, sending, setSending, error, setError };
}

/** An assistant-ui runtime over messages from props, where a new message is plain text to send. */
export function useTextRuntime<T>(messages: T[], convert: (message: T) => ThreadMessageLike, send: (text: string) => Promise<string | null>) {
  const adapter = {
    messages,
    convertMessage: convert,
    isRunning: false,
    onNew: async (message: AppendMessage) => {
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const failed = await send(text);
      if (failed) throw new Error(failed);
    },
  };
  // The adapter's type is conditional on T, which TypeScript can't settle while T is generic;
  // the two callers' message types aren't assistant-ui messages, so the converter form applies.
  return useExternalStoreRuntime<T>(adapter as unknown as ExternalStoreAdapter<T>);
}

/**
 * The scrolling log: Show earlier messages when there are more, `empty` while a loaded
 * conversation has no messages, then the messages.
 */
export const ThreadLog: React.FC<{
  more: boolean;
  onLoadOlder: () => Promise<void>;
  /** Shown once loading is done and nothing came back. */
  empty: React.ReactNode | null;
  children: React.ReactNode;
}> = ({ more, onLoadOlder, empty, children }) => (
  <ThreadPrimitive.Viewport className="wb-log wb-circle-log" role="log" aria-label="Messages">
    {more ? (
      <Button variant="secondary" block type="button" className="wb-circle-older" onClick={() => void onLoadOlder()}>
        Show earlier messages
      </Button>
    ) : null}
    {empty ? <div className="wb-circle-empty">{empty}</div> : null}
    {children}
  </ThreadPrimitive.Viewport>
);

/** The dialog that asks before a message is deleted. */
export const DeleteSheet: React.FC<{
  open: boolean;
  busy: boolean;
  title: string;
  titleId: string;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  children: React.ReactNode;
}> = ({ open, busy, title, titleId, error, onClose, onConfirm, children }) => (
  <Sheet
    open={open}
    onClose={onClose}
    busy={busy}
    titleId={titleId}
    title={title}
    error={error}
    actions={
      <SheetConfirmActions busy={busy} tone="danger" confirmLabel={busy ? 'Deleting…' : 'Delete'} onCancel={onClose} onConfirm={onConfirm} />
    }
  >
    <p className="wb-sheet-help">{children}</p>
  </Sheet>
);

/**
 * Mark `newest` read while the window has focus, and again when focus returns. Read only with
 * focus, as main stays silent only then (ADR 0051 §5): a message marked read in a visible but
 * unfocused window would be dropped from its notification. `again` re-marks when it changes.
 */
export function useReadWhileFocused<T>(newest: T | undefined, markRead: (message: T) => void, again?: unknown): void {
  const doc = useOwnerDocument();
  useEffect(() => {
    if (!newest) return;
    const win = doc.defaultView ?? window;
    if (doc.hasFocus()) markRead(newest);
    const onFocus = (): void => markRead(newest);
    win.addEventListener('focus', onFocus);
    return () => win.removeEventListener('focus', onFocus);
  }, [newest, markRead, again, doc]);
}

/**
 * The composer's keys: Escape cancels a reply when `cancel` is given, and Enter without Shift
 * sends, unless an input method is composing.
 */
export function composerKey(event: React.KeyboardEvent<HTMLTextAreaElement>, cancel: (() => void) | null, send: () => void): void {
  if (event.key === 'Escape' && cancel) {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    send();
  }
}
