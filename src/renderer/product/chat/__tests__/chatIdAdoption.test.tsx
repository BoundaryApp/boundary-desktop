import React, { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../../../preload';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesChatPhaseEvent } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

type HermesChatAPI = ElectronAPI['hermesChat'];
let bridge: FakeBridge;
let chat: FakeHermesChat;
let getHistory: Mock<HermesChatAPI['getHistory']>;

// A DM placeholder gets its real session on the first send.
function installBridge() {
  // Each chat's history is empty, under the id it was asked for.
  getHistory = vi.fn<HermesChatAPI['getHistory']>(async ({ sessionId }) => ({
    success: true,
    sessionId,
    messages: [],
  }));
  ({ bridge, chat } = installChatBridge('real-1', { hermesChat: { getHistory } }));
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setValue } from '../../../__tests__/formInput';

/** The open chat, swapping to a resolved id the way WorkbenchChatScreen does. */
const Chat: React.FC<{ initialId: string | null }> = ({ initialId }) => {
  const [id, setId] = useState<string | null>(initialId);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const sameChat = useCallback(
    (a: string, b: string) => a === b || (aliases[a] ?? a) === (aliases[b] ?? b),
    [aliases]
  );
  const resolved = useCallback((next: string) => {
    setId((current) => {
      if (current && current !== next) {
        setAliases((prev) => ({ ...prev, [next]: prev[current] ?? current }));
      }
      return next;
    });
  }, []);
  return (
    <HostedChatRuntime sessionId={id} onSessionResolved={resolved} sameChat={sameChat}>
      <WorkbenchThread {...threadProps({ sessionId: id, sameChat, threadTitle: 'Orchestrator' })} />
    </HostedChatRuntime>
  );
};

const phase = (event: HermesChatPhaseEvent) => bridge.emit('hermes-chat:phase', event);

describe('a chat that gets its session on the first send', () => {
  beforeEach(installBridge);
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('keeps the sent prompt and the live turn when the real id comes back', async () => {
    render(<Chat initialId="placeholder-1" />);
    await ipcCalls.settle();

    const input = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    await act(async () => setValue(input, 'Put a task on the board'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();

    expect(chat.startChat).toHaveBeenCalledTimes(1);
    // The chat adopted its real id in place: no reload that would wipe the turn.
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByText('Put a task on the board')).toBeTruthy();

    const requestId = chat.requestId();
    await phase({ requestId, sessionId: 'real-1', phase: 'preparing' });
    expect(screen.getAllByText('Preparing…').length).toBeGreaterThan(0);

    await chat.stream('On the board.');
    await chat.finish();
    expect(screen.getByText('On the board.')).toBeTruthy();
  });

  it('keeps the first prompt of a new chat, which has no id until the send', async () => {
    render(<Chat initialId={null} />);
    await ipcCalls.settle();

    const input = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    await act(async () => setValue(input, 'Plan the week'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();

    expect(chat.startChat).toHaveBeenCalledTimes(1);
    // The new id is adopted in place, so Hermes' history (without the prompt yet) is never
    // loaded over the turn.
    expect(getHistory).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByText('Plan the week')).toBeTruthy();

    const requestId = chat.requestId();
    await phase({ requestId, sessionId: 'real-1', phase: 'preparing' });
    expect(screen.getAllByText('Preparing…').length).toBeGreaterThan(0);

    await chat.stream('Here is a plan.');
    await chat.finish();
    expect(screen.getByText('Here is a plan.')).toBeTruthy();
  });
});

describe("another chat's turn", () => {
  beforeEach(installBridge);
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('does not show its progress in the chat that is open', async () => {
    render(<Chat initialId="chat-b" />);
    await ipcCalls.settle();
    await phase({ requestId: 'req-elsewhere', sessionId: 'chat-a', phase: 'preparing' });
    expect(screen.queryByText('Preparing…')).toBeNull();
    await phase({ requestId: 'req-elsewhere', sessionId: 'chat-a', phase: 'tool', toolName: 'kanban_create' });
    expect(document.querySelector('.wb-phase-line')).toBeNull();
  });
});
