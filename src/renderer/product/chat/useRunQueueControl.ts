import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAui } from '@assistant-ui/store';
import { QUEUED_RUN_CONFIG } from './hermesChatModelAdapter';
import { interruptNextAbort } from './runInterrupts';
import type { HermesRunControl } from '../../../shared/types/hermesChat';
import {
  enqueuePrompt,
  pauseRunQueue,
  rekeyRunQueue,
  removeQueuedPrompt,
  resumeRunQueue,
  shiftQueuedPrompt,
  takeQueuedPrompt,
  useRunQueue,
} from './runQueue';
import { useBusySendPref } from './busySendPref';
import { useOwnerDocument } from '../../components/ui/ownerDocument';
import { BUSY_SEND_CHOICES, BUSY_SEND_DEFAULT_INDEX, type BusySendChoice } from './BusySendMenu';

/**
 * Enter while an agent replies, and the queue (run-control spec, Phase 2). The thread passes
 * what it knows about the run and the composer; this owns the menu, the queue's chips, Send
 * now and draining.
 */
export function useRunQueueControl({
  sessionId,
  sameChat,
  stoppable,
  running,
  backgroundRequestId,
  canSend,
  prepareSend,
  applyQuote,
  focusInput,
  announce,
  takeVoiceChip,
  restoreVoiceChip,
}: {
  sessionId: string | null;
  sameChat?: (a: string, b: string) => boolean;
  /** A reply is running on this chat: streamed here, or a turn left running in Hermes. */
  stoppable: boolean;
  /** This screen's runtime is streaming the reply. */
  running: boolean;
  /** The request id of a turn this screen didn't start, when that is what runs. */
  backgroundRequestId: string | null;
  /** Nothing blocks a send right now (approval, credential, restart…). */
  canSend: boolean;
  /** The checks a send makes; false when nothing may go out yet. */
  prepareSend: () => boolean;
  /** Puts a waiting quote into the composer's text. */
  applyQuote: () => void;
  focusInput: () => void;
  announce: (text: string) => void;
  /** Takes the composer's writing voice chip with the draft (ADR 0056 §8); null when none. */
  takeVoiceChip?: () => string | null;
  /** Puts a queued message's chip back when it is edited. */
  restoreVoiceChip?: (voiceId: string | null) => void;
}) {
  const aui = useAui();
  const key = sessionId ?? '';
  const queue = useRunQueue(key);
  const [pref, setPref] = useBusySendPref();
  const alwaysQueue = pref === 'queue';
  const [menuIndex, setMenuIndex] = useState<number | null>(null);
  const ownerDocument = useOwnerDocument();
  const menuOpen = menuIndex !== null;
  // Send now waits for the reply it stops to end before sending (LocalRuntime runs one at a time).
  const [pendingSend, setPendingSend] = useState<{
    text: string;
    via: HermesRunControl;
    voiceId: string | null;
  } | null>(null);

  // A new chat queues under '' until its first send names it; a runtime id that gives way to
  // its stored id keeps the queue too.
  const keyRef = useRef(key);
  useEffect(() => {
    const prev = keyRef.current;
    keyRef.current = key;
    if (prev === key || !key) return;
    if (prev === '' || (sameChat?.(prev, key) ?? false)) rekeyRunQueue(prev, key);
  }, [key, sameChat]);

  // append starts its run a tick later, so until the run shows, nothing else may send.
  const awaitingRunRef = useRef(false);
  useEffect(() => {
    if (stoppable) awaitingRunRef.current = false;
  }, [stoppable]);

  const send = useCallback(
    (text: string, via: HermesRunControl, voiceId?: string | null) => {
      awaitingRunRef.current = true;
      aui.thread.append({
        role: 'user',
        content: [{ type: 'text', text }],
        runConfig: {
          custom: {
            ...(via === 'queue-drain' ? QUEUED_RUN_CONFIG.custom : {}),
            via,
            ...(voiceId ? { writingVoiceId: voiceId } : {}),
          },
        },
      });
    },
    [aui]
  );

  /** Stops the running reply as interrupted (spec 2.3), then sends `text` once it has ended. */
  const interruptAndSend = useCallback(
    (text: string, via: HermesRunControl, voiceId: string | null = null) => {
      setPendingSend({ text, via, voiceId });
      if (running) {
        interruptNextAbort(via);
        aui.thread.cancelRun();
      } else if (backgroundRequestId) {
        void window.electronAPI.hermesChat.cancelChat({
          requestId: backgroundRequestId,
          reason: 'interrupted',
          via,
        });
      }
    },
    [aui, backgroundRequestId, running]
  );

  useEffect(() => {
    if (pendingSend === null || stoppable || awaitingRunRef.current) return;
    setPendingSend(null);
    send(pendingSend.text, pendingSend.via, pendingSend.voiceId);
  }, [pendingSend, send, stoppable]);

  // A reply that ended under the menu: close it, keep the draft, and the next Enter sends.
  useEffect(() => {
    if (!stoppable) setMenuIndex(null);
  }, [stoppable]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!(event.target as Element | null)?.closest?.('.wb-busy-menu')) setMenuIndex(null);
    };
    ownerDocument.addEventListener('mousedown', onDown);
    return () => ownerDocument.removeEventListener('mousedown', onDown);
  }, [menuOpen, ownerDocument]);

  // Drain: once this chat is idle and open, send the head. A failed reply pauses the queue
  // as Stop does (stopRun pauses it itself), so nothing goes out after an error unseen.
  useEffect(() => {
    if (stoppable || pendingSend !== null || !canSend) return;
    if (queue.items.length === 0 || queue.paused) return;
    if (awaitingRunRef.current) return;
    const last = aui.thread.getState().messages.at(-1);
    if (last?.role === 'assistant' && last.status?.type === 'incomplete' && last.status.reason === 'error') {
      pauseRunQueue(key);
      return;
    }
    const head = shiftQueuedPrompt(key);
    if (head) send(head.text, 'queue-drain', head.voiceId);
  }, [aui, canSend, key, pendingSend, queue, send, stoppable]);

  const takeDraft = useCallback((): string => {
    applyQuote();
    const text = aui.composer.getState().text;
    aui.composer.setText('');
    return text;
  }, [aui, applyQuote]);

  const queueDraft = useCallback(() => {
    setMenuIndex(null);
    const text = takeDraft();
    if (!text.trim()) return;
    if (!enqueuePrompt(key, text, takeVoiceChip?.() ?? null)) return;
    announce(`Queued. Sends when the reply finishes.`);
    focusInput();
  }, [announce, focusInput, key, takeDraft, takeVoiceChip]);

  const sendDraftNow = useCallback((via: HermesRunControl) => {
    setMenuIndex(null);
    if (!prepareSend()) return;
    const text = aui.composer.getState().text;
    if (!text.trim()) return;
    aui.composer.setText('');
    interruptAndSend(text, via, takeVoiceChip?.() ?? null);
    focusInput();
  }, [aui, focusInput, interruptAndSend, prepareSend, takeVoiceChip]);

  const pick = useCallback(
    (choice: BusySendChoice, how: 'enter' | 'click' = 'click') => {
      if (choice === 'now') sendDraftNow(how === 'enter' ? 'send-now-menu-enter' : 'send-now-menu-click');
      else if (choice === 'queue') queueDraft();
      else {
        setMenuIndex(null);
        focusInput();
      }
    },
    [focusInput, queueDraft, sendDraftNow]
  );

  /** Composer keys while a reply runs. True when it handled the key. */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (menuIndex !== null) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setMenuIndex((menuIndex + step + BUSY_SEND_CHOICES.length) % BUSY_SEND_CHOICES.length);
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          setMenuIndex(null);
          return true;
        }
      }
      if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || !stoppable) {
        return false;
      }
      event.preventDefault();
      if (!aui.composer.getState().text.trim()) return true;
      if (event.metaKey || event.ctrlKey) sendDraftNow('send-now-cmd-enter');
      else if (menuIndex !== null) pick(BUSY_SEND_CHOICES[menuIndex].id, 'enter');
      else if (alwaysQueue) queueDraft();
      else setMenuIndex(BUSY_SEND_DEFAULT_INDEX);
      return true;
    },
    [alwaysQueue, aui, menuIndex, pick, queueDraft, sendDraftNow, stoppable]
  );

  const sendQueuedNow = useCallback(
    (id: string) => {
      if (!stoppable && !canSend) return;
      const item = takeQueuedPrompt(key, id);
      if (!item) return;
      // Sending from a paused queue picks it back up: the rest follow this reply.
      resumeRunQueue(key);
      if (stoppable) interruptAndSend(item.text, 'send-now-chip', item.voiceId ?? null);
      else send(item.text, 'send-now-chip', item.voiceId);
    },
    [canSend, interruptAndSend, key, send, stoppable]
  );

  const editQueued = useCallback(
    (id: string) => {
      const item = takeQueuedPrompt(key, id);
      if (!item) return;
      const draft = aui.composer.getState().text;
      aui.composer.setText(draft.trim() ? `${draft}\n\n${item.text}` : item.text);
      if (item.voiceId) restoreVoiceChip?.(item.voiceId);
      focusInput();
    },
    [aui, focusInput, key, restoreVoiceChip]
  );

  const removeQueued = useCallback((id: string) => removeQueuedPrompt(key, id), [key]);

  /** Stop pauses the queue and never sends or drops what's in it (spec 2.5). */
  const pauseQueue = useCallback(() => pauseRunQueue(key), [key]);

  return {
    queue,
    menuIndex,
    alwaysQueue,
    setAlwaysQueue: (on: boolean) => setPref(on ? 'queue' : 'ask'),
    pick,
    handleKeyDown,
    pauseQueue,
    chips: {
      items: queue.items,
      paused: queue.paused,
      canSendHead: queue.paused || stoppable,
      onSendNow: sendQueuedNow,
      onEdit: editQueued,
      onRemove: removeQueued,
    },
  };
}
