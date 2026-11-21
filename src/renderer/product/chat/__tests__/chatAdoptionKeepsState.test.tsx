import React, { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesChatStartResult } from '../../../../shared/types/hermesChat';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));
vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setValue } from '../../../__tests__/formInput';

const NEWS: WritingVoiceView = {
  id: 'news',
  name: 'News',
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: '',
  calibratedAt: null,
  sampleHash: '',
  style: null,
  samplesChanged: false,
  step: null,
};

let bridge: FakeBridge;
let chat: FakeHermesChat;
/** Lets the held `startChat` answer, which hands the new chat its id. */
let answerStart: () => void;

function installBridge() {
  ({ bridge, chat } = installChatBridge('real-1', {
    writingVoices: { list: async () => ({ success: true, voices: [NEWS] }) },
  }));
  const answer = chat.startChat.getMockImplementation()!;
  chat.startChat.mockImplementation((payload) =>
    ipcCalls.hold(
      new Promise<HermesChatStartResult>((resolve) => {
        answerStart = () => resolve(answer(payload));
      })
    )
  );
}

/** The screen's open chat: the empty composer, or one chat, swapped to a resolved id. */
const Chat: React.FC<{ initialId: string | null; open?: (go: (id: string) => void) => void }> = ({
  initialId,
  open,
}) => {
  const [id, setId] = useState<string | null>(initialId);
  open?.(setId);
  const sameChat = useCallback((a: string, b: string) => a === b, []);
  return (
    <HostedChatRuntime sessionId={id} onSessionResolved={setId} sameChat={sameChat}>
      <WorkbenchThread {...threadProps({ sessionId: id, sameChat, threadTitle: 'Orchestrator' })} />
    </HostedChatRuntime>
  );
};

const pressCmdF = async () => {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  });
};

const composer = () => screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;

/** Puts the News chip on the next message through the / menu. */
async function pickNewsChip() {
  await act(async () => setValue(composer(), '/ne'));
  await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
  expect(screen.getByText('✎ News')).toBeTruthy();
}

const findBar = () => screen.queryByRole('searchbox', { name: 'Search this DM' });

describe('per-chat state when a new chat gets its id', () => {
  beforeEach(installBridge);
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('keeps the find bar and the voice chip through the first send', async () => {
    render(<Chat initialId={null} />);
    await ipcCalls.settle();

    await act(async () => setValue(composer(), 'Plan the week'));
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
    await ipcCalls.settle();
    expect(chat.startChat).toHaveBeenCalledTimes(1);

    // While the send waits for its session: open the find bar and chip the next message.
    await pressCmdF();
    expect(findBar()).toBeTruthy();
    await pickNewsChip();

    await act(async () => answerStart());
    await ipcCalls.settle();

    // The id resolved in place; both are still there.
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(findBar()).toBeTruthy();
    expect(screen.getByText('✎ News')).toBeTruthy();
  });

  it('shows a refused first send once the chat has its id', async () => {
    render(<Chat initialId={null} />);
    await ipcCalls.settle();

    chat.nextStart = { success: false, errorCode: 'private-refused', error: 'Refused.' };
    await act(async () => setValue(composer(), 'Plan the week'));
    await act(async () => fireEvent.keyDown(composer(), { key: 'Enter' }));
    await act(async () => answerStart());
    await ipcCalls.settle();

    // The refusal reaches the thread through the send handlers the provider hands the
    // adapter; main kept the failed send as a chat, whose id the thread adopted.
    expect(screen.getByRole('alert').textContent).toContain('This project is private');
  });

  it('clears both when another chat opens', async () => {
    let go: (id: string) => void = () => undefined;
    render(<Chat initialId="chat-a" open={(fn) => (go = fn)} />);
    await ipcCalls.settle();

    await pressCmdF();
    expect(findBar()).toBeTruthy();
    await pickNewsChip();

    await act(async () => go('chat-b'));
    await ipcCalls.settle();

    expect(findBar()).toBeNull();
    expect(screen.queryByText('✎ News')).toBeNull();
  });
});
