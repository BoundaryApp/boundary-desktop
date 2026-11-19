import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { HermesChatMessage, HermesChatStartPayload } from '../../../../shared/types/hermesChat';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

let bridge: FakeBridge;
let chat: FakeHermesChat;
let getHistory: Mock<NonNullable<FakeHermesChat['leaves']['getHistory']>>;

/** Main with one Hermes chat, s1, whose runs stay open until a test ends them. */
function installBridge() {
  ({ bridge, chat } = installChatBridge('s1', (fake) => {
    getHistory = vi.fn(fake.leaves.getHistory!);
    return { hermesChat: { getHistory } };
  }));
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setRunningTurnsForTests } from '../runningTurns';
import { noReplyText } from '../TurnNotes';
import { setValue } from '../../../__tests__/formInput';

const Chat: React.FC = () => (
  <HostedChatRuntime sessionId="s1">
    <WorkbenchThread {...threadProps({ sessionId: 's1', threadTitle: 'Hermes', agents: [] })} />
  </HostedChatRuntime>
);

const asked: HermesChatMessage = { role: 'user', content: 'Where do cron scripts live?', rowId: 7 };
const running = (requestId: string) =>
  setRunningTurnsForTests([
    { requestId, sessionIds: ['s1'], agentSlug: null, startedAt: new Date(Date.now() - 95_000).toISOString() },
  ]);

// By role: the placeholder changes while a turn runs.
const input = () => screen.getByRole('textbox') as HTMLTextAreaElement;
describe('turn notes', () => {
  beforeEach(() => {
    installBridge();
    setRunningTurnsForTests([]);
  });
  afterEach(() => {
    cleanup();
    setRunningTurnsForTests([]);
    expect(bridge.unfaked).toEqual([]);
  });

  it('says why a reopened chat has no reply, and Retry reruns that message', async () => {
    chat.history = [{ ...asked, noReply: { reason: 'failed', error: 'rate limited' } }];
    render(<Chat />);
    expect(await screen.findByText(/couldn’t reply/)).toBeTruthy();
    expect(screen.getByText(/rate limited/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    const payload = chat.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload;
    expect(payload.rewind).toEqual(expect.objectContaining({ rowId: 7 }));
    expect(payload.messages).toEqual([{ role: 'user', content: 'Where do cron scripts live?' }]);
  });

  it('calls an unanswered message with no note what it is', async () => {
    chat.history = [asked];
    render(<Chat />);
    expect(await screen.findByText('No reply to this message')).toBeTruthy();
  });

  it('shows a turn still running from before, then loads its reply in place', async () => {
    chat.history = [asked];
    running('req-away');
    render(<Chat />);
    // The same compact form as a kanban task running for as long.
    expect(await screen.findByText(/is still working · 1m$/)).toBeTruthy();
    expect(screen.queryByText('No reply to this message')).toBeNull();
    await act(async () => setValue(input(), 'half-typed follow-up'));

    chat.history = [asked, { role: 'assistant', content: 'In /etc/cron.d.', rowId: 8 }];
    await act(async () => setRunningTurnsForTests([]));

    expect(await screen.findByText('In /etc/cron.d.')).toBeTruthy();
    expect(screen.queryByText(/still working/)).toBeNull();
    expect(screen.queryByText('No reply to this message')).toBeNull();
    // Loaded in place: the draft survives.
    expect(input().value).toBe('half-typed follow-up');
  });

  it('marks a live reply that ended without text, without reloading its own turn', async () => {
    render(<Chat />);
    await screen.findByRole('button', { name: 'Send message' });
    await act(async () => setValue(input(), 'hello?'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));
    await waitFor(() => expect(chat.startChat).toHaveBeenCalled());
    await act(async () => running(chat.requestId()));

    await chat.finish({ noReply: { reason: 'halted' } });
    await act(async () => setRunningTurnsForTests([]));

    expect(await screen.findByText(/stopped without replying/)).toBeTruthy();
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});

describe('a send refused because nothing answered', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('says so under the turn, and Retry sends the message again', async () => {
    const error = 'OpenRouter didn’t answer, so your message wasn’t sent.';
    chat.startChat.mockImplementationOnce(async (payload) => ({
      success: false,
      requestId: payload.requestId,
      error,
      errorCode: 'provider-unreachable',
    }));
    render(<Chat />);
    await screen.findByRole('button', { name: 'Send message' });
    await act(async () => setValue(input(), 'hello?'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));

    const note = (await screen.findByText(error)).closest('p')!;
    await act(async () => fireEvent.click(within(note).getByRole('button', { name: 'Retry' })));
    await waitFor(() => expect(chat.startChat).toHaveBeenCalledTimes(2));
    expect(chat.startChat.mock.calls[1][0].messages.at(-1)).toMatchObject({ role: 'user', content: 'hello?' });
  });

  it('links a send stopped on a shared model to its provider', async () => {
    const error = 'Bo isn’t sharing qwen3-8b right now.';
    chat.startChat.mockImplementation(async (payload: HermesChatStartPayload) => ({
      success: false,
      requestId: payload.requestId,
      error,
      errorCode: 'apply-failed',
      provider: 'b'.repeat(64),
    }));
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener('boundary:open-inference', listener);
    render(<Chat />);
    await screen.findByRole('button', { name: 'Send message' });
    await act(async () => setValue(input(), 'hello?'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send message' })));

    const note = (await screen.findByText(error)).closest('p')!;
    fireEvent.click(within(note).getByRole('button', { name: 'Open in Inference' }));
    window.removeEventListener('boundary:open-inference', listener);
    expect(opened).toEqual([{ person: 'b'.repeat(64) }]);
  });
});

describe('turn note copy', () => {
  it('names each way a reply can fail to arrive', () => {
    expect(noReplyText('stopped', 'Iris')).toBe('Stopped before Iris replied');
    expect(noReplyText('timeout', 'Iris')).toBe('No reply after 3 minutes');
    expect(noReplyText('unknown', 'Iris')).toBe('No reply to this message');
  });
});
