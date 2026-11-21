import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { AgentProfile, HermesRunningTurn } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

// Runs stay open until a test streams text into them and finishes them.
let bridge: FakeBridge;
let chat: FakeHermesChat;
/** Called when the adapter subscribes to a run's stream, just before it calls startChat. */
let onListen: (() => void) | null = null;

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { STOP_GUARD_MS, WorkbenchThread } from '../WorkbenchThread';
import { setRunningTurnsForTests } from '../runningTurns';
import { setValue } from '../../../__tests__/formInput';
import { clearRunQueuesForTests } from '../runQueue';
import { resetRunInterruptsForTests } from '../runInterrupts';
import { BUSY_SEND_STORAGE_KEY, resetBusySendPrefForTests } from '../busySendPref';

const researcher: AgentProfile = {
  slug: 'researcher',
  displayName: 'Researcher',
  handle: 'Researcher',
  role: 'Digs things up',
  builtIn: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const Chat: React.FC = () => (
  <HostedChatRuntime sessionId="s1">
    <WorkbenchThread {...threadProps({ sessionId: 's1', agents: [researcher] })} />
  </HostedChatRuntime>
);

/** Renders the chat once its history and the rest of its first loads are in. */
async function renderChat() {
  render(<Chat />);
  await ipcCalls.settle();
}

/** Clicks Stop and waits for the cancel to reach Hermes and the reply to settle. */
async function clickStop() {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop response' })));
  await ipcCalls.settle();
}

const stream = (delta: string) => chat.stream(delta);
const finish = () => chat.finish();

// By role: the placeholder changes while a reply runs (Enter asks what to do with a draft).
const input = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const lastPayload = () => chat.startChat.mock.calls.at(-1)?.[0];

let now = 1_000_000;
const later = () => {
  now += STOP_GUARD_MS + 50;
};

/** Resolves once the adapter has Hermes's answer to startChat and listens for the reply. */
const nextRunListening = () =>
  new Promise<void>((resolve) => {
    onListen = resolve;
  });

/** Clicks a control that starts a run, and waits until the run listens for Hermes. */
async function startRun(control: HTMLElement) {
  const listening = nextRunListening();
  await act(async () => fireEvent.click(control));
  // Stop shows as soon as the run starts, before Hermes has answered startChat. Text streamed
  // or a Stop pressed before then would land on a run that is not listening yet.
  await act(() => listening);
}

/** Types a prompt, sends it with the run button, and waits for the run to start. */
async function sendPrompt(text: string) {
  await act(async () => setValue(input(), text));
  await startRun(screen.getByRole('button', { name: 'Send message' }));
  expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
}

describe('Run control', () => {
  beforeEach(() => {
    ({ bridge, chat } = installChatBridge('s1', (_chat, fake) => ({
      hermesChat: {
        onChatChunk: (cb) => {
          const off = fake.listen('hermes-chat:chunk')(cb);
          onListen?.();
          return off;
        },
      },
    })));
    onListen = null;
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    setRunningTurnsForTests([]);
    clearRunQueuesForTests();
    resetRunInterruptsForTests();
    window.localStorage.removeItem(BUSY_SEND_STORAGE_KEY);
    resetBusySendPrefForTests();
    vi.restoreAllMocks();
    expect(bridge.unfaked).toEqual([]);
  });

  it('shows Send, never Stop, while idle; Send is inert until there is a draft', async () => {
    await renderChat();
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull();

    await act(async () => setValue(input(), 'hello'));
    expect(send.getAttribute('aria-disabled')).toBe('false');
  });

  it('turns into Stop for the run, and stopping leaves Stopped by you with Continue', async () => {
    await renderChat();
    await sendPrompt('write the letter');
    expect(lastPayload()?.messages.at(-1)).toEqual({ role: 'user', content: 'write the letter' });

    await stream('Dear Sam, I wanted to');
    later();
    await clickStop();

    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId: chat.requestId(), reason: 'stopped', via: 'stop' });
    // The partial text stays, in one reply that carries the note.
    const replies = [...document.querySelectorAll('.wb-msg.is-assistant')] as HTMLElement[];
    expect(replies).toHaveLength(1);
    expect(within(replies[0]).getByText('Dear Sam, I wanted to')).toBeTruthy();
    expect(within(replies[0]).getByText('Stopped by you')).toBeTruthy();
    expect(screen.getByText('Response stopped')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy();
  });

  it('ignores a Stop that lands right after the send (a double-click on Send)', async () => {
    await renderChat();
    await sendPrompt('hello');

    await clickStop();
    expect(chat.cancelChat).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
    await finish();
  });

  it('continues a stopped reply without a new prompt', async () => {
    await renderChat();
    await sendPrompt('write the letter');
    await stream('Dear Sam, I wanted to');
    later();
    await clickStop();

    await startRun(screen.getByRole('button', { name: /Continue/ }));
    expect(lastPayload()?.continue).toBe(true);
    await stream(' say thank you.');
    await finish();

    expect(screen.getByText(/say thank you\./)).toBeTruthy();
    // The stopped reply is no longer the latest, so it no longer offers Continue.
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('says so when a stop lands before any text', async () => {
    await renderChat();
    await sendPrompt('hello');
    later();
    await clickStop();

    // The same line, in the same markup, as the note a reload shows under the prompt.
    const line = screen.getByText('Stopped before Hermes replied');
    expect(line.closest('.wb-turn-note')?.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('cancels on Hermes when Stop lands before startChat answers', async () => {
    let answer!: () => void;
    let requestId = '';
    chat.startChat.mockImplementationOnce(
      (payload) =>
        ipcCalls.hold(
          new Promise((resolve) => {
            answer = () => {
              requestId = payload.requestId;
              resolve({ success: true, requestId: payload.requestId, sessionId: 's1' });
            };
          })
        )
    );
    await renderChat();
    // Not sendPrompt: that waits for the run to listen, which needs startChat's answer.
    await act(async () => setValue(input(), 'hello'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
    expect(chat.startChat).toHaveBeenCalled();
    later();
    await clickStop();
    expect(chat.cancelChat).not.toHaveBeenCalled();

    await act(async () => answer());
    await ipcCalls.settle();

    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId, reason: 'stopped', via: 'stop' });
    expect(await screen.findByText('Stopped before Hermes replied')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });

  it('stops on Esc, but an open mention list takes Esc first', async () => {
    await renderChat();
    await sendPrompt('hello');
    later();

    await act(async () => setValue(input(), '@'));
    expect(screen.getByRole('listbox', { name: 'Mention' })).toBeTruthy();
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(screen.queryByRole('listbox', { name: 'Mention' })).toBeNull();
    expect(chat.cancelChat).not.toHaveBeenCalled();

    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId: chat.requestId(), reason: 'stopped', via: 'stop' });
  });

  it('does nothing on Esc while idle', async () => {
    await renderChat();
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(chat.cancelChat).not.toHaveBeenCalled();
  });

  it('keeps how replies ended across a reload', async () => {
    chat.history = [
      { role: 'user', content: 'first', rowId: 1 },
      { role: 'assistant', content: 'half a thought', rowId: 2, ending: 'interrupted' },
      { role: 'user', content: 'second', rowId: 3 },
      { role: 'assistant', content: 'Dear Sam', rowId: 4, ending: 'stopped' },
    ];
    await renderChat();

    expect(screen.getByText(/Interrupted by your next message/)).toBeTruthy();
    expect(screen.getByText('Stopped by you')).toBeTruthy();
    // Only the latest stopped reply can be continued.
    expect(screen.getAllByRole('button', { name: /Continue/ })).toHaveLength(1);
  });

  // A turn this window did not start, such as another window's. Stop cancels it on Hermes by
  // its request id.
  it('stops a turn another window started, with the button and with Esc', async () => {
    const away: Omit<HermesRunningTurn, 'requestId'> = { sessionIds: ['s1'], agentSlug: null, startedAt: new Date(now).toISOString() };
    setRunningTurnsForTests([{ requestId: 'req-away', ...away }]);
    await renderChat();
    expect(screen.getByText(/is still working/)).toBeTruthy();

    await clickStop();
    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId: 'req-away', reason: 'stopped' });

    chat.cancelChat.mockClear();
    await act(async () => setRunningTurnsForTests([{ requestId: 'req-other', ...away }]));
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(chat.cancelChat).toHaveBeenCalledWith({ requestId: 'req-other', reason: 'stopped' });

    await act(async () => setRunningTurnsForTests([]));
    expect(screen.queryByRole('button', { name: 'Stop response' })).toBeNull();
  });

  describe('Enter while a reply runs (Phase 2)', () => {
    const enter = (opts: { metaKey?: boolean } = {}) =>
      act(async () => fireEvent.keyDown(input(), { key: 'Enter', ...opts }));
    const chips = () => [...document.querySelectorAll('.wb-qchip')] as HTMLElement[];
    const chipLabels = () => chips().map((c) => c.querySelector('.wb-qchip-label')?.textContent);
    const sentTexts = () => chat.startChat.mock.calls.map(([p]) => p.messages.at(-1)?.content);

    /** Types a draft mid-run and queues it with Enter, Enter. */
    async function queueDraft(text: string) {
      await act(async () => setValue(input(), text));
      await enter();
      await enter();
    }

    /** Finishes the running reply and waits for the queue's next send to listen. */
    async function finishIntoNext() {
      const listening = nextRunListening();
      await finish();
      await act(() => listening);
    }

    it('asks first: Enter opens the menu, sends nothing, and keeps the draft', async () => {
      await renderChat();
      await sendPrompt('first');
      await act(async () => setValue(input(), 'second'));
      await enter();

      const menu = screen.getByRole('listbox', { name: /is still replying/ });
      expect(
        within(menu)
          .getAllByRole('option')
          .map((b) => b.querySelector('[data-slot="menu-item-label"]')?.textContent)
      ).toEqual([
        'Send now',
        'Queue',
        'Keep editing',
      ]);
      const queue = within(menu).getByRole('option', { name: /Queue/ });
      expect(queue.hasAttribute('data-active')).toBe(true);
      // The composer names the list and the row Enter will take.
      expect(input().getAttribute('aria-controls')).toBe(menu.id);
      expect(input().getAttribute('aria-activedescendant')).toBe(queue.id);
      await act(async () => fireEvent.keyDown(input(), { key: 'ArrowUp' }));
      expect(input().getAttribute('aria-activedescendant')).toBe(
        within(menu).getByRole('option', { name: /Send now/ }).id
      );
      await act(async () => fireEvent.keyDown(input(), { key: 'ArrowDown' }));
      expect(chat.startChat).toHaveBeenCalledTimes(1);
      expect(input().value).toBe('second');

      // Esc closes the menu only: the reply keeps running.
      later();
      await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(chat.cancelChat).not.toHaveBeenCalled();
      expect(input().value).toBe('second');
      await finish();
    });

    it('queues on Enter twice and sends the queue in order, each after the reply before it', async () => {
      await renderChat();
      await sendPrompt('first');
      await queueDraft('second');
      await queueDraft('third');

      expect(chipLabels()).toEqual(['Next', 'Queued 2']);
      expect(input().value).toBe('');
      expect(screen.getByText('Queued. Sends when the reply finishes.')).toBeTruthy();
      expect(chat.cancelChat).not.toHaveBeenCalled();
      expect(chat.startChat).toHaveBeenCalledTimes(1);

      await finishIntoNext();
      expect(sentTexts()).toEqual(['first', 'second']);
      expect(lastPayload()).toMatchObject({ queued: true, via: 'queue-drain' });
      expect(chipLabels()).toEqual(['Next']);

      await finishIntoNext();
      expect(sentTexts()).toEqual(['first', 'second', 'third']);
      expect(chips()).toEqual([]);
      await finish();
    });

    it('closes the menu when the reply ends under it, and the next Enter sends', async () => {
      await renderChat();
      await sendPrompt('first');
      await act(async () => setValue(input(), 'second'));
      await enter();
      expect(screen.getByRole('listbox')).toBeTruthy();

      await finish();
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(input().value).toBe('second');
    });

    it('Stop pauses the queue and loses nothing; Send now on the paused head sends it', async () => {
      await renderChat();
      await sendPrompt('first');
      await queueDraft('second');
      await queueDraft('third');
      later();
      await clickStop();

      expect(chipLabels()).toEqual(['Paused', 'Paused']);
      expect(chat.startChat).toHaveBeenCalledTimes(1);

      // A message sent by hand leaves the queue paused.
      await sendPrompt('by hand');
      await finish();
      expect(chipLabels()).toEqual(['Paused', 'Paused']);

      const listening = nextRunListening();
      await act(async () => fireEvent.click(within(chips()[0]).getByRole('button', { name: 'Send now' })));
      await act(() => listening);
      expect(sentTexts()).toEqual(['first', 'by hand', 'second']);
      // Sending from the paused queue picks it back up.
      expect(chipLabels()).toEqual(['Next']);
      await finishIntoNext();
      expect(sentTexts().at(-1)).toBe('third');
      await finish();
    });

    it('Send now (⌘↵) interrupts the reply, then sends the draft', async () => {
      await renderChat();
      await sendPrompt('write the letter');
      await stream('Dear Sam, I wanted to');
      const interruptedRequest = chat.requestId();
      await act(async () => setValue(input(), 'make it shorter'));

      const listening = nextRunListening();
      await enter({ metaKey: true });
      await act(() => listening);

      expect(chat.cancelChat).toHaveBeenCalledWith({
        requestId: interruptedRequest,
        reason: 'interrupted',
        via: 'send-now-cmd-enter',
      });
      expect(lastPayload()?.via).toBe('send-now-cmd-enter');
      expect(sentTexts()).toEqual(['write the letter', 'make it shorter']);
      expect(lastPayload()?.queued).toBeUndefined();
      expect(screen.getByText(/Interrupted by your next message/)).toBeTruthy();
      expect(screen.queryByText('Stopped by you')).toBeNull();
      await finish();
    });

    it('Send now from the menu does the same', async () => {
      await renderChat();
      await sendPrompt('first');
      await act(async () => setValue(input(), 'second'));
      await enter();
      const listening = nextRunListening();
      await act(async () => fireEvent.click(screen.getByRole('option', { name: /Send now/ })));
      await act(() => listening);
      expect(chat.cancelChat).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'interrupted', via: 'send-now-menu-click' })
      );
      expect(sentTexts()).toEqual(['first', 'second']);
      await finish();
    });

    it('with Always queue, Enter queues without asking', async () => {
      window.localStorage.setItem(BUSY_SEND_STORAGE_KEY, 'queue');
      await renderChat();
      await sendPrompt('first');
      await act(async () => setValue(input(), 'second'));
      await enter();
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(chipLabels()).toEqual(['Next']);
      expect(within(chips()[0]).getByRole('button', { name: 'Send now' })).toBeTruthy();
      await finishIntoNext();
      await finish();
    });

    it('the menu’s Always queue box sets the preference', async () => {
      await renderChat();
      await sendPrompt('first');
      await act(async () => setValue(input(), 'second'));
      await enter();
      await act(async () => fireEvent.click(screen.getByRole('checkbox', { name: /Always queue/ })));
      expect(window.localStorage.getItem(BUSY_SEND_STORAGE_KEY)).toBe('queue');
      await finish();
    });

    it('keeps a chat’s queue while you are away and sends it when you return', async () => {
      await renderChat();
      await sendPrompt('first');
      await queueDraft('second');
      cleanup();
      expect(chat.startChat).toHaveBeenCalledTimes(1);

      const listening = nextRunListening();
      await renderChat();
      await act(() => listening);
      expect(sentTexts()).toEqual(['first', 'second']);
      await finish();
    });

    it('Edit takes a queued message back into the composer', async () => {
      await renderChat();
      await sendPrompt('first');
      await queueDraft('second');
      await act(async () => fireEvent.click(within(chips()[0]).getByRole('button', { name: 'Edit' })));
      expect(chips()).toEqual([]);
      expect(input().value).toBe('second');
      await finish();
    });

    it('× removes a queued message', async () => {
      await renderChat();
      await sendPrompt('first');
      await queueDraft('second');
      await act(async () =>
        fireEvent.click(within(chips()[0]).getByRole('button', { name: 'Remove from queue' }))
      );
      expect(chips()).toEqual([]);
      await finish();
      expect(chat.startChat).toHaveBeenCalledTimes(1);
    });
  });
});
