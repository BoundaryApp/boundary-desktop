import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

// Runs stay open until a test replies to them (`reply`). Main answers with the adapter's id.
let bridge: FakeBridge;
let chat: FakeHermesChat;

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setValue } from '../../../__tests__/formInput';

const Chat: React.FC<{ isChannel?: boolean }> = ({ isChannel = false }) => (
  <HostedChatRuntime sessionId="s1">
    <WorkbenchThread {...threadProps({ sessionId: 's1', kind: isChannel ? 'channel' : null })} />
  </HostedChatRuntime>
);

/** Renders the chat once its history and the rest of its first loads are in. */
async function renderChat(props: { isChannel?: boolean } = {}) {
  render(<Chat {...props} />);
  await ipcCalls.settle();
}

/** Hermes answers the open run with `text` and ends it. */
async function reply(text: string) {
  await chat.stream(text);
  await chat.finish();
}

const lastPayload = () => chat.startChat.mock.calls.at(-1)?.[0];

describe('Edit and Retry', () => {
  beforeEach(() => {
    ({ bridge, chat } = installChatBridge('s1'));
    chat.history = [
      { role: 'user', content: 'first', rowId: 10, timestamp: 1767225600 },
      { role: 'assistant', content: 'reply one', rowId: 11, timestamp: 1767225610 },
      { role: 'user', content: 'second', rowId: 12, timestamp: 1767225620 },
      { role: 'assistant', content: 'reply two', rowId: 13, timestamp: 1767225630 },
    ];
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('edits a prompt as a rewind, then retries the new reply', async () => {
    await renderChat();
    expect(screen.getByText('reply two')).toBeTruthy();

    // Both hydrated prompts are on the server, so both can be edited.
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    expect(edits).toHaveLength(2);

    await act(async () => fireEvent.click(edits[1]));
    const editor = screen.getByLabelText('Edit message') as HTMLTextAreaElement;
    expect(editor.value).toBe('second');
    expect(screen.getByText(/Sends as version 2/)).toBeTruthy();

    await act(async () => setValue(editor, 'second, sharper'));
    const form = editor.closest('.wb-editor') as HTMLElement;
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: /Send/ })));
    await ipcCalls.settle();
    expect(lastPayload()?.rewind).toEqual({ userOrdinal: 1, rowId: 12, expectedText: 'second' });
    expect(lastPayload()?.messages.at(-1)).toEqual({ role: 'user', content: 'second, sharper' });

    await reply('reply three');
    expect(screen.getByText('reply three')).toBeTruthy();
    const counts = [...document.querySelectorAll('.wb-versions-count')].map((c) => c.textContent);
    expect(counts).toContain('2 / 2');
    expect(screen.getByText('edited')).toBeTruthy();

    // Retry the new reply: same prompt, sent live this session, so no row id yet.
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    await act(async () => fireEvent.click(retries[retries.length - 1]));
    await ipcCalls.settle();
    expect(lastPayload()?.rewind).toEqual({ userOrdinal: 1, expectedText: 'second, sharper' });
    await reply('reply four');
    expect(screen.getByText('reply four')).toBeTruthy();
  });

  it('sends a normal message without a rewind', async () => {
    await renderChat();
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => setValue(input, 'third'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();
    expect(chat.startChat).toHaveBeenCalledTimes(1);
    expect(lastPayload()?.rewind).toBeUndefined();
  });

  it('offers no Edit or Retry in channels', async () => {
    await renderChat({ isChannel: true });
    expect(screen.getByText('reply two')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
