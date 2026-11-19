import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type { CalendarAccountView } from '../../../../shared/types/calendars';
import { HostedChatRuntime, installChatBridge, threadProps } from './threadHarness';

const ipcCalls = await vi.hoisted(() => import('./ipcCalls'));
ipcCalls.settleBeforeWaits();

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

let bridge: FakeBridge;
let chat: FakeHermesChat;
/** The request id main gave the open run. */
let active = '';
let n = 0;
let accounts: CalendarAccountView[] = [];

function installBridge() {
  ({ bridge, chat } = installChatBridge('s1', {
    calendars: { list: async () => ({ success: true, accounts }) },
  }));
  // Runs stay open until a test replies to them (`ask`), on the request id the renderer made.
  chat.startChat.mockImplementation(async (payload) => {
    n += 1;
    active = payload.requestId ?? `req-${n}`;
    return { success: true, requestId: active, sessionId: 's1' };
  });
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { setValue } from '../../../__tests__/formInput';

const Chat: React.FC = () => (
  <HostedChatRuntime sessionId="s1">
    <WorkbenchThread {...threadProps({ sessionId: 's1' })} />
  </HostedChatRuntime>
);

/**
 * Sends `text`, then Hermes runs `tool` (if any) and replies. Hermes decides whether to call
 * offer_setup; these tests stand in for that choice and check what Boundary does with it.
 */
async function ask(text: string, tool: { name: string; args?: Record<string, unknown> } | null, answer: string) {
  const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
  await act(async () => setValue(input, text));
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  await ipcCalls.settle();
  await bridge.emit('hermes-chat:phase', { requestId: active, sessionId: 's1', phase: 'preparing' });
  if (tool) {
    for (const status of ['running', 'done'] as const) {
      await bridge.emit('hermes-chat:tool', { requestId: active, sessionId: 's1', toolId: 't1', name: tool.name, status, args: tool.args });
    }
  }
  await bridge.emit('hermes-chat:chunk', { requestId: active, delta: answer });
  await bridge.emit('hermes-chat:end', { requestId: active });
  await ipcCalls.settle();
}

const card = () => screen.queryByRole('group', { name: 'Connect a calendar' });
const OFFER = { name: 'mcp_boundary_offer_setup', args: { kind: 'calendar' } };

describe('Connect a calendar card (calendar spec 3.1)', () => {
  beforeEach(() => {
    active = '';
    accounts = [];
    installBridge();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it('shows the card under the reply that called offer_setup', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await ask('What do I have on Thursday?', OFFER, 'I can’t see a calendar yet.');
    expect(card()).toBeTruthy();
    expect(screen.getByText(/You’ll need an app password/)).toBeTruthy();
  });

  it('shows nothing for a reply that didn’t call it', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await ask('How do Hebrew calendars work?', { name: 'web_search', args: { query: 'Hebrew calendar' } }, 'It is lunisolar.');
    expect(card()).toBeNull();
  });

  it('Connect calendar opens the connect sheet over Settings → Calendars', async () => {
    const opened = vi.fn();
    const listener = (event: Event) => opened((event as CustomEvent).detail);
    window.addEventListener('boundary:open-settings', listener);
    render(<Chat />);
    await ipcCalls.settle();
    await ask('What do I have on Thursday?', OFFER, 'I can’t see a calendar yet.');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect calendar' })));
    window.removeEventListener('boundary:open-settings', listener);
    expect(opened).toHaveBeenCalledWith({ tab: 'calendars', connectFromChat: true });
  });

  it('is still there after Settings unmounted the chat, and goes on Not now', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await ask('What do I have on Thursday?', OFFER, 'I can’t see a calendar yet.');
    cleanup();
    render(<Chat />);
    await ipcCalls.settle();
    expect(card()).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Not now' })));
    expect(card()).toBeNull();
  });

  it('goes when the next turn starts without one', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await ask('What do I have on Thursday?', OFFER, 'I can’t see a calendar yet.');
    await ask('Never mind, what’s 2 + 2?', null, '4');
    expect(card()).toBeNull();
  });

  it('hides once a calendar is connected', async () => {
    render(<Chat />);
    await ipcCalls.settle();
    await ask('What do I have on Thursday?', OFFER, 'I can’t see a calendar yet.');
    cleanup();
    accounts = [{ slug: 'personal', name: 'Personal' } as CalendarAccountView];
    render(<Chat />);
    await ipcCalls.settle();
    expect(card()).toBeNull();
  });
});
