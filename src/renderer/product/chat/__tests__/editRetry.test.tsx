import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { HermesChatStartPayload } from '../../../../shared/types/hermesChat';

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
const ipc = vi.hoisted(() => ({
  chunk: new Set<Listener>(),
  end: new Set<Listener>(),
  error: new Set<Listener>(),
  active: null as string | null,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};
// Runs stay open until a test replies to them (`reply`). Main answers with the adapter's id.
ipc.startChat = vi.fn(async ({ requestId }: { requestId: string }) => {
  ipc.active = requestId;
  return { success: true, requestId, sessionId: 's1' };
});

stubElectronAPI({
  hermesChat: {
    getHistory: ipcCalls.track(vi.fn().mockResolvedValue({
      success: true,
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'first', rowId: 10, timestamp: 1767225600 },
        { role: 'assistant', content: 'reply one', rowId: 11, timestamp: 1767225610 },
        { role: 'user', content: 'second', rowId: 12, timestamp: 1767225620 },
        { role: 'assistant', content: 'reply two', rowId: 13, timestamp: 1767225630 },
      ],
    })),
    startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
    cancelChat: vi.fn().mockResolvedValue(undefined),
    onChatChunk: on(ipc.chunk),
    onChatEnd: on(ipc.end),
    onChatError: on(ipc.error),
    listPendingCredentialRequests: ipcCalls.track(async () => []),
    getContextBreakdown: ipcCalls.track(async () => ({
      success: true,
      breakdown: { categories: [] },
    })),
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

const Chat: React.FC<{ isChannel?: boolean }> = ({ isChannel = false }) => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Assistant"
      kind={isChannel ? 'channel' : null}
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
);

/** Renders the chat once its history and the rest of its first loads are in. */
async function renderChat(props: { isChannel?: boolean } = {}) {
  render(<Chat {...props} />);
  await ipcCalls.settle();
}

/** Hermes answers the open run with `text` and ends it. */
const reply = (text: string) =>
  act(async () => {
    for (const cb of ipc.chunk) cb({ requestId: ipc.active!, delta: text });
    for (const cb of ipc.end) cb({ requestId: ipc.active! });
  });

const lastPayload = () =>
  ipc.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload | undefined;

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

describe('Edit and Retry', () => {
  beforeEach(() => {
    ipc.active = null;
    ipc.startChat.mockClear();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
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
    expect(ipc.startChat).toHaveBeenCalledTimes(1);
    expect(lastPayload()?.rewind).toBeUndefined();
  });

  it('offers no Edit or Retry in channels', async () => {
    await renderChat({ isChannel: true });
    expect(screen.getByText('reply two')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
