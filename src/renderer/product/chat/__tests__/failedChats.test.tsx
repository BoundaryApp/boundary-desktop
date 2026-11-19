import React, { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../../../preload';
import type { FakeBridge } from '../../../__tests__/fakeBridge';
import type { HermesChatMessage, HermesChatStartResult } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

type HermesChatAPI = ElectronAPI['hermesChat'];
let bridge: FakeBridge;
let getHistory: Mock<HermesChatAPI['getHistory']>;
let startChat: Mock<HermesChatAPI['startChat']>;
let listThreads: Mock<HermesChatAPI['listThreads']>;

/**
 * What main keeps, per hermesFailedChats.test.ts: a failed send comes back under a chat id, and
 * the chat's history holds it as a `localOnly` row with its error.
 */
let chats: Record<string, HermesChatMessage[]> = {};
let down = true;
let nextId = 1;
const ERROR = "Couldn't reach the assistant stack: connect failed. Check that it is running, then retry.";

/** Main with the test's own history, sends and chat list, no agents, rooms or mentions. */
function installBridge() {
  ({ bridge } = installChatBridge('s1', (_chat, fake) => ({
    hermesChat: {
      getHistory,
      startChat,
      listThreads,
      listMentions: async () => ({ success: true, mentions: [] }),
      onSessionsChanged: fake.listen('hermes-chat:sessions-changed'),
    },
    agents: {
      onChanged: fake.listen('hermes-agents:changed'),
      list: async () => ({ success: true, agents: [], standingDmByAgent: {} }),
    },
    channels: {
      list: async () => ({ success: true, channels: [], lastOpened: null }),
    },
  })));
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { useChatIds } from '../useChatIds';
import { useChatLists } from '../useChatLists';
import { setValue } from '../../../__tests__/formInput';

const Chat: React.FC<{ initialId?: string | null }> = ({ initialId = null }) => {
  const [id, setId] = useState<string | null>(initialId);
  const resolved = useCallback((next: string) => setId(next), []);
  return (
    <>
      <button type="button" onClick={() => setId(null)}>
        Start over
      </button>
      <output data-testid="open-chat">{id ?? 'none'}</output>
      <HostedChatRuntime sessionId={id} onSessionResolved={resolved}>
        <WorkbenchThread {...threadProps({ sessionId: id, threadTitle: 'Chat' })} />
      </HostedChatRuntime>
    </>
  );
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

const lastStart = () => startChat.mock.calls.at(-1)![0];

async function finishTurn() {
  const { requestId } = lastStart();
  await bridge.emit('hermes-chat:chunk', { requestId, delta: 'Here you go.' });
  await bridge.emit('hermes-chat:end', { requestId, finishReason: 'stop' });
  await ipcCalls.settle();
}

describe('a chat whose send failed', () => {
  beforeEach(() => {
    chats = {};
    down = true;
    nextId = 1;
    listThreads = vi.fn<HermesChatAPI['listThreads']>();
    getHistory = vi.fn<HermesChatAPI['getHistory']>(async ({ sessionId }) => ({
      success: true,
      sessionId,
      messages: chats[sessionId] ?? [],
    }));
    startChat = vi.fn<HermesChatAPI['startChat']>(
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
    installBridge();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
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

/** The rail and open chat, on the hooks WorkbenchChatScreen keeps them in. */
const Screen: React.FC = () => {
  const ids = useChatIds(null);
  const lists = useChatLists(null, ids);
  const { adoptResolvedId } = ids;
  const { renameThread } = lists;
  const resolved = useCallback(
    (id: string, storedId?: string) => adoptResolvedId(id, renameThread, storedId),
    [adoptResolvedId, renameThread]
  );
  return (
    <>
      <nav aria-label="Chats">
        {lists.threads.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={ids.sameChat(t.id, ids.activeThreadId) ? 'true' : undefined}
            onClick={() => ids.setActiveThreadId(t.id)}
          >
            {t.title}
          </button>
        ))}
      </nav>
      <HostedChatRuntime
        sessionId={ids.activeThreadId}
        onSessionResolved={resolved}
        sameChat={ids.sameChat}
      >
        <WorkbenchThread
          {...threadProps({ sessionId: ids.activeThreadId, sameChat: ids.sameChat, threadTitle: 'Chat' })}
        />
      </HostedChatRuntime>
    </>
  );
};

/**
 * What main answers for a refused send and its Retry, per hermesFailedChats.test.ts: results carry
 * the runtime id and the stored id, and the list holds the stored id, titled from the message.
 */
describe('retrying a refused send in the open chat', () => {
  const REFUSED = 'The default shared model is offline.';
  const row = (id: string, title = 'Plan my week') => ({ id, title, kind: 'hermes' as const });
  type StartAnswer = Omit<HermesChatStartResult, 'requestId'>;
  const started = (result: StartAnswer) =>
    startChat.mockImplementationOnce(async ({ requestId }) => ({
      requestId,
      ...result,
    }));
  const refused = (sessionId: string, storedSessionId: string): StartAnswer => ({
    success: false,
    sessionId,
    storedSessionId,
    errorCode: 'provider-unreachable',
    error: REFUSED,
  });
  const listing = (...threads: ReturnType<typeof row>[]) =>
    listThreads.mockResolvedValue({ success: true, threads });

  /** Main says sessions changed; the rail lists again once the burst settles. */
  async function sessionsChanged() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await bridge.emit('hermes-chat:sessions-changed', undefined);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    vi.useRealTimers();
    await ipcCalls.settle();
  }

  const rail = () => within(screen.getByRole('navigation', { name: 'Chats' }));
  const expectOneActiveRow = () => {
    const rows = rail().getAllByRole('button');
    expect(rows.map((b) => b.textContent)).toEqual(['Plan my week']);
    expect(rows[0]!.getAttribute('aria-current')).toBe('true');
  };

  async function retry(result: StartAnswer) {
    started(result);
    getHistory.mockClear();
    const note = screen.getByText(REFUSED).closest('.wb-turn-note') as HTMLElement;
    await act(async () => fireEvent.click(within(note).getByRole('button', { name: 'Retry' })));
    await ipcCalls.settle();
  }

  async function refusedInNewChat() {
    listing(row('stored-1', 'New chat'));
    render(<Screen />);
    await ipcCalls.settle();
    started(refused('run-1', 'stored-1'));
    await sendMessage('Plan my week');
    listing(row('stored-1'));
    await sessionsChanged();
    expectOneActiveRow();
    expect(screen.getByText(REFUSED)).toBeTruthy();
  }

  beforeEach(() => {
    startChat = vi.fn<HermesChatAPI['startChat']>();
    listThreads = vi.fn<HermesChatAPI['listThreads']>();
    getHistory = vi.fn<HermesChatAPI['getHistory']>(async ({ sessionId }) => ({
      success: true,
      sessionId,
      messages: [],
    }));
    installBridge();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('keeps one active row and the transcript when the session is still live', async () => {
    await refusedInNewChat();
    await retry({ success: true, sessionId: 'run-1', storedSessionId: 'stored-1' });
    expect(lastStart()).toMatchObject({
      sessionId: 'run-1',
      rewind: { userOrdinal: 0, expectedText: 'Plan my week' },
    });
    await sessionsChanged();
    await finishTurn();

    expectOneActiveRow();
    expect(getHistory).not.toHaveBeenCalled();
    expect(screen.getByText('Here you go.')).toBeTruthy();
  });

  it('keeps one active row when the Retry had to start a new session', async () => {
    await refusedInNewChat();
    await retry({ success: true, sessionId: 'run-2', storedSessionId: 'stored-2' });
    listing(row('stored-2'));
    await sessionsChanged();
    await finishTurn();

    expectOneActiveRow();
    expect(getHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByText('Here you go.')).toBeTruthy();
  });

  it('marks the row of a chat whose first send came from the empty composer', async () => {
    listing();
    render(<Screen />);
    await ipcCalls.settle();
    started(refused('run-1', 'stored-1'));
    // An empty composer has no history to keep, so the chat loads its kept send from main.
    getHistory.mockResolvedValueOnce({
      success: true,
      sessionId: 'run-1',
      messages: [
        {
          role: 'user',
          content: 'Plan my week',
          timestamp: 1_790_000_000,
          noReply: { reason: 'unreachable', error: REFUSED },
          localOnly: true,
        },
      ],
    });
    await sendMessage('Plan my week');
    listing(row('stored-1'));
    await sessionsChanged();
    expectOneActiveRow();

    await retry({ success: true, sessionId: 'run-1', storedSessionId: 'stored-1' });
    await sessionsChanged();
    await finishTurn();
    expectOneActiveRow();
  });
});
