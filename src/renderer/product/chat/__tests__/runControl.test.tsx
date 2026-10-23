import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentProfile,
  HermesChatMessage,
  HermesChatStartPayload,
} from '../../../../shared/types/hermesChat';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= noop;

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

type Listener = (event: { requestId: string; delta?: string; error?: string }) => void;
// Runs stay open until a test streams text into them and finishes them.
const ipc = vi.hoisted(() => ({
  chunk: new Set<Listener>(),
  end: new Set<Listener>(),
  error: new Set<Listener>(),
  history: [] as HermesChatMessage[],
  active: null as string | null,
  /** Called when the adapter subscribes to a run's stream, i.e. Hermes answered startChat. */
  onListen: null as (() => void) | null,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
  cancelChat: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  const on = (set: Set<Listener>) => (cb: Listener) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  let n = 0;
  ipc.startChat = vi.fn(async () => {
    n += 1;
    ipc.active = `req-${n}`;
    return { success: true, requestId: ipc.active, sessionId: 's1', transport: 'json-rpc' };
  });
  // An implementation, not mockResolvedValue: restoreAllMocks between tests would drop that.
  ipc.cancelChat = vi.fn(async () => ({ success: true }));
  return {
    hermesChatIPC: {
      getHistory: ipcCalls.track(async () => ({
        success: true,
        sessionId: 's1',
        messages: ipc.history,
      })),
      startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
      cancelChat: ipcCalls.track((...args: unknown[]) => ipc.cancelChat(...args)),
      onChatChunk: (cb: Listener) => {
        const off = on(ipc.chunk)(cb);
        ipc.onListen?.();
        return off;
      },
      onChatEnd: on(ipc.end),
      onChatError: on(ipc.error),
      onChatPhase: unsub,
      onChatTool: unsub,
      onChatApproval: unsub,
      onChatCredentialRequest: unsub,
      listPendingCredentialRequests: ipcCalls.track(async () => []),
      onChatTurnStats: unsub,
      onChatSpeaker: unsub,
      getContextBreakdown: ipcCalls.track(async () => ({
        success: true,
        breakdown: { categories: [] },
      })),
      completePath: ipcCalls.track(async () => ({ success: true, items: [] })),
    },
  };
});

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: ipcCalls.track(async () => ({ configured: true, slots: {} })),
    probeSlotHealth: ipcCalls.track(async () => ({ health: 'reachable' })),
  },
}));

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { STOP_GUARD_MS, WorkbenchThread } from '../WorkbenchThread';

const researcher: AgentProfile = {
  slug: 'researcher',
  displayName: 'Researcher',
  handle: 'Researcher',
  role: 'Digs things up',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const Chat: React.FC = () => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Assistant"
      agents={[researcher]}
      activeProject={null}
      projects={[]}
      activeProjectId={null}
      toolsEnabled
      onToolsEnabledChange={noop}
      onSelectProject={noop}
      onClearProject={noop}
      onNewProject={noop}
    />
  </HermesChatRuntimeProvider>
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

const stream = (delta: string) =>
  act(async () => {
    for (const cb of ipc.chunk) cb({ requestId: ipc.active!, delta });
  });
const finish = () =>
  act(async () => {
    for (const cb of ipc.end) cb({ requestId: ipc.active! });
  });

const input = () => screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};
const lastPayload = () =>
  ipc.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload | undefined;

let now = 1_000_000;
const later = () => {
  now += STOP_GUARD_MS + 50;
};

/** Resolves once the adapter has Hermes's answer to startChat and listens for the reply. */
const nextRunListening = () =>
  new Promise<void>((resolve) => {
    ipc.onListen = resolve;
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
    ipc.history = [];
    ipc.active = null;
    ipc.onListen = null;
    ipc.startChat.mockClear();
    ipc.cancelChat.mockClear();
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    vi.restoreAllMocks();
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

    expect(ipc.cancelChat).toHaveBeenCalledWith({ requestId: ipc.active, reason: 'stopped' });
    expect(screen.getByText('Stopped by you')).toBeTruthy();
    expect(screen.getByText('Response stopped')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy();
  });

  it('ignores a Stop that lands right after the send (a double-click on Send)', async () => {
    await renderChat();
    await sendPrompt('hello');

    await clickStop();
    expect(ipc.cancelChat).not.toHaveBeenCalled();
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

    expect(screen.getByText('Stopped before Hermes replied')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('cancels on Hermes when Stop lands before startChat answers', async () => {
    let answer!: () => void;
    ipc.startChat.mockImplementationOnce(
      () =>
        ipcCalls.hold(
          new Promise((resolve) => {
            answer = () => {
              ipc.active = 'req-slow';
              resolve({ success: true, requestId: 'req-slow', sessionId: 's1', transport: 'json-rpc' });
            };
          })
        )
    );
    await renderChat();
    // Not sendPrompt: that waits for the run to listen, which needs startChat's answer.
    await act(async () => setValue(input(), 'hello'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
    expect(ipc.startChat).toHaveBeenCalled();
    later();
    await clickStop();
    expect(ipc.cancelChat).not.toHaveBeenCalled();

    await act(async () => answer());
    await ipcCalls.settle();

    expect(ipc.cancelChat).toHaveBeenCalledWith({ requestId: 'req-slow', reason: 'stopped' });
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
    expect(ipc.cancelChat).not.toHaveBeenCalled();

    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(ipc.cancelChat).toHaveBeenCalledWith({ requestId: ipc.active, reason: 'stopped' });
  });

  it('does nothing on Esc while idle', async () => {
    await renderChat();
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }));
    expect(ipc.cancelChat).not.toHaveBeenCalled();
  });

  it('keeps how replies ended across a reload', async () => {
    ipc.history = [
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
});
