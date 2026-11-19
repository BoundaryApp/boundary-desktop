import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesChatPhaseEvent, HermesHeldTurn, HermesRunningTurn } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

// A send to a local model that is already answering in another chat waits in Boundary
// (workload plan Phase 1a). Main is faked: it answers startChat, then reports the hold.

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { STOP_GUARD_MS, WorkbenchThread } from '../WorkbenchThread';
import { RunningTurnDot } from '../WorkingDot';
import { setRunningTurnsForTests } from '../runningTurns';
import { setValue } from '../../../__tests__/formInput';
import { clearRunQueuesForTests } from '../runQueue';
import { resetRunInterruptsForTests } from '../runInterrupts';

let bridge: FakeBridge;
let chat: FakeHermesChat;
let onListen: (() => void) | null = null;
const runHeldTurnNow = vi.fn(async () => ({ success: true }));
const openTrip = vi.fn();

const resolveChat = (id: string) => (id === 'chat-a' ? { label: 'Trip research', open: openTrip } : null);

const Chat: React.FC = () => (
  <HostedChatRuntime sessionId="chat-b">
    <WorkbenchThread {...threadProps({ sessionId: 'chat-b' })} resolveChat={resolveChat} />
  </HostedChatRuntime>
);

const input = () => screen.getByRole('textbox') as HTMLTextAreaElement;

async function sendPrompt(text: string) {
  await act(async () => setValue(input(), text));
  const listening = new Promise<void>((resolve) => {
    onListen = resolve;
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
  await act(() => listening);
}

const held = (over: Partial<HermesHeldTurn> = {}): HermesHeldTurn => ({
  position: 1,
  ahead: 1,
  limit: 1,
  runningSessionIds: ['chat-a'],
  ...over,
});

const phase = (event: Omit<HermesChatPhaseEvent, 'requestId' | 'sessionId'>) =>
  bridge.emit('hermes-chat:phase', { requestId: chat.requestId(), sessionId: 'chat-b', ...event });

let now = 1_000_000;

describe('a turn held for the local model', () => {
  beforeEach(() => {
    ({ bridge, chat } = installChatBridge('chat-b', (_chat, fake) => ({
      hermesChat: {
        runHeldTurnNow,
        onChatChunk: (cb) => {
          const off = fake.listen('hermes-chat:chunk')(cb);
          onListen?.();
          return off;
        },
      },
    })));
    onListen = null;
    runHeldTurnNow.mockClear();
    openTrip.mockClear();
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    setRunningTurnsForTests([]);
    clearRunQueuesForTests();
    resetRunInterruptsForTests();
    vi.restoreAllMocks();
    expect(bridge.unfaked).toEqual([]);
  });

  it('shows Stop and the waiting line naming the answering chat, then goes live when it ends', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendPrompt('plan the trip');

    await phase({ phase: 'held', held: held() });
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeTruthy();
    const line = document.querySelector('.wb-held-line') as HTMLElement;
    expect(line.textContent).toContain('Waiting for the local model · answering in Trip research');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Trip research' })));
    expect(openTrip).toHaveBeenCalled();

    // Chat A ends: main admits B, which runs as any turn does.
    await phase({ phase: 'preparing', elapsedSec: 0 });
    expect(screen.queryByText(/Waiting for the local model/)).toBeNull();
    await chat.stream('Here is a plan.');
    await chat.finish();
    await ipcCalls.settle();
    expect(screen.getByText('Here is a plan.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop response' })).toBeNull();
  });

  it('counts the turns ahead when more than one is', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendPrompt('third in line');
    await phase({ phase: 'held', held: held({ position: 2, ahead: 2 }) });
    expect(screen.getByText(/Waiting for the local model · 2 ahead · answering in/)).toBeTruthy();
  });

  it('Run now asks main to start the held turn', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendPrompt('now please');
    await phase({ phase: 'held', held: held() });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Run now' })));
    expect(runHeldTurnNow).toHaveBeenCalledWith({ requestId: chat.requestId() });
  });

  it('Stop on the held turn cancels only its own request', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await sendPrompt('never mind');
    await phase({ phase: 'held', held: held() });
    now += STOP_GUARD_MS + 50;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop response' })));
    await ipcCalls.settle();
    expect(chat.cancelChat).toHaveBeenCalledWith(expect.objectContaining({ requestId: chat.requestId() }));
    expect(chat.cancelChat).toHaveBeenCalledTimes(1);
  });
});

describe('RunningTurnDot', () => {
  afterEach(cleanup);
  const turn: HermesRunningTurn = { requestId: 'r', sessionIds: ['s'], agentSlug: null, startedAt: '2026-11-12T10:00:00Z' };

  it('is hollow while the turn waits for the local model', () => {
    render(<RunningTurnDot turn={{ ...turn, admission: 'held' }} label="Marlow is working" />);
    const dot = screen.getByRole('img', { name: 'Waiting for the local model' });
    expect(dot.className).toContain('is-held');
  });

  it('is the working dot once the turn runs', () => {
    render(<RunningTurnDot turn={{ ...turn, admission: 'running' }} label="Marlow is working" />);
    expect(screen.getByRole('img', { name: 'Marlow is working' }).className).not.toContain('is-held');
  });
});
