import React, { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HermesChatMessage } from '../../../../shared/types/hermesChat';

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

type Listener = (event: Record<string, unknown>) => void;
const ipc = vi.hoisted(() => ({
  chunk: new Set<(e: Record<string, unknown>) => void>(),
  end: new Set<(e: Record<string, unknown>) => void>(),
  error: new Set<(e: Record<string, unknown>) => void>(),
  getHistory: null as unknown as ReturnType<typeof vi.fn>,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
}));

/**
 * What main keeps, per hermesFailedChats.test.ts: a failed send comes back under a chat id, and
 * the chat's history holds it as a `localOnly` row with its error.
 */
let chats: Record<string, HermesChatMessage[]> = {};
let down = true;
let nextId = 1;
const ERROR = "Couldn't reach the assistant stack: connect failed. Check that it is running, then retry.";

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};

stubElectronAPI({
  hermesChat: {
    getHistory: ipcCalls.track((...args: unknown[]) => ipc.getHistory(...args)),
    startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
    cancelChat: vi.fn(),
    onChatChunk: on(ipc.chunk as Set<Listener>),
    onChatEnd: on(ipc.end as Set<Listener>),
    onChatError: on(ipc.error as Set<Listener>),
    listPendingCredentialRequests: ipcCalls.track(async () => []),
    getContextBreakdown: ipcCalls.track(vi.fn().mockResolvedValue({ success: false })),
  },
  onboarding: {
    getStatus: ipcCalls.track(vi.fn().mockResolvedValue({ configured: true, slots: {} })),
    probeSlotHealth: ipcCalls.track(vi.fn().mockResolvedValue({ health: 'reachable' })),
  },
  projects: {
    completePath: ipcCalls.track(vi.fn().mockResolvedValue({ success: true, items: [] })),
  },
});

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { WorkbenchThread } from '../WorkbenchThread';

const Chat: React.FC<{ initialId?: string | null }> = ({ initialId = null }) => {
  const [id, setId] = useState<string | null>(initialId);
  const resolved = useCallback((next: string) => setId(next), []);
  return (
    <>
      <button type="button" onClick={() => setId(null)}>
        Start over
      </button>
      <output data-testid="open-chat">{id ?? 'none'}</output>
      <HermesChatRuntimeProvider sessionId={id} onSessionResolved={resolved}>
        <WorkbenchThread
          sessionId={id}
          threadTitle="Chat"
          activeProject={null}
          projects={[]}
          activeProjectId={null}
          toolsEnabled
          onToolsEnabledChange={noop}
          onSelectProject={noop}
          onClearProject={noop}
          onNewProject={noop}
          onCreateAgentFromDraft={noop}
          onEditAgentDraft={noop}
        />
      </HermesChatRuntimeProvider>
    </>
  );
};

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

async function sendMessage(text: string) {
  const input = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
  await act(async () => setValue(input, text));
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  await ipcCalls.settle();
}

const openChat = () => screen.getByTestId('open-chat').textContent;

async function relaunch(id: string) {
  await ipcCalls.settle();
  cleanup();
  render(<Chat initialId={id} />);
  await ipcCalls.settle();
}

const lastStart = () => ipc.startChat.mock.calls.at(-1)![0] as Record<string, unknown>;

async function finishTurn() {
  const { requestId } = lastStart();
  await act(async () => {
    for (const cb of ipc.chunk) cb({ requestId, delta: 'Here you go.' });
    for (const cb of ipc.end) cb({ requestId, finishReason: 'stop' });
  });
  await ipcCalls.settle();
}

describe('a chat whose send failed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chats = {};
    down = true;
    nextId = 1;
    ipc.getHistory = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      success: true,
      sessionId,
      messages: chats[sessionId] ?? [],
    }));
    ipc.startChat = vi.fn(
      async (payload: {
        requestId: string;
        sessionId?: string;
        messages: HermesChatMessage[];
        retry?: boolean;
      }) => {
        const text = payload.messages.at(-1)!.content;
        const id = payload.sessionId ?? `failed-${nextId++}`;
        if (down) {
          const rows = chats[id] ?? [];
          if (!payload.retry) {
            rows.push({
              role: 'user',
              content: text,
              timestamp: 1_790_000_000 + rows.length,
              noReply: { reason: 'unreachable', error: ERROR },
              localOnly: true,
            });
          }
          chats[id] = rows;
          return {
            success: false,
            requestId: payload.requestId,
            sessionId: id,
            errorCode: 'gateway-unreachable',
            error: ERROR,
          };
        }
        const rows = chats[id] ?? [];
        rows.push({ role: 'user', content: text, rowId: rows.length + 1 });
        chats['run-1'] = rows;
        return { success: true, requestId: payload.requestId, sessionId: 'run-1' };
      }
    );
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
  });

  it('opens under its own id, showing the message and the error', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendMessage('Plan my week');
    expect(openChat()).toBe('failed-1');
    expect(screen.getByText('Plan my week')).toBeTruthy();
    expect(screen.getByText(ERROR)).toBeTruthy();
  });

  it('shows the same after a relaunch', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendMessage('Plan my week');
    await relaunch('failed-1');
    expect(screen.getByText('Plan my week')).toBeTruthy();
    expect(screen.getByText(ERROR)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('keeps two failed chats in a row apart', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendMessage('First');
    await act(async () => fireEvent.click(screen.getByText('Start over')));
    await ipcCalls.settle();
    await sendMessage('Second');
    expect(openChat()).toBe('failed-2');
    expect(chats['failed-1']?.map((m) => m.content)).toEqual(['First']);
    expect(chats['failed-2']?.map((m) => m.content)).toEqual(['Second']);

    await relaunch('failed-1');
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.queryByText('Second')).toBeNull();
  });

  it('retries in the same chat after a relaunch, and the chat becomes a Hermes chat', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendMessage('Plan my week');
    await relaunch('failed-1');

    down = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    await ipcCalls.settle();
    expect(lastStart()).toMatchObject({ sessionId: 'failed-1', retry: true });
    expect(lastStart().rewind).toBeUndefined();
    expect(openChat()).toBe('run-1');

    await finishTurn();
    expect(screen.getByText('Here you go.')).toBeTruthy();
    // The error stays where it happened, above the reply.
    expect(screen.getByText(ERROR)).toBeTruthy();
  });

  it('continues the chat from the composer, leaving the failed turn in the transcript', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendMessage('First');
    await relaunch('failed-1');

    down = false;
    await sendMessage('Second');
    expect(lastStart()).toMatchObject({ sessionId: 'failed-1' });
    expect(lastStart().retry).toBeUndefined();
    expect(lastStart().rewind).toBeUndefined();
    await finishTurn();
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText(ERROR)).toBeTruthy();
    expect(screen.getByText('Here you go.')).toBeTruthy();
  });

  it('offers no Retry on a failed turn once the chat has moved on', async () => {
    chats['kept'] = [
      {
        role: 'user',
        content: 'Earlier',
        timestamp: 1_790_000_000,
        noReply: { reason: 'unreachable', error: ERROR },
        localOnly: true,
      },
      { role: 'user', content: 'Later', rowId: 1, timestamp: 1_790_000_100 },
      { role: 'assistant', content: 'Reply', rowId: 2, timestamp: 1_790_000_101 },
    ];
    render(<Chat initialId="kept" />);
    await ipcCalls.settle();
    const note = screen.getByText(ERROR).closest('.wb-turn-note') as HTMLElement;
    expect(within(note).queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
