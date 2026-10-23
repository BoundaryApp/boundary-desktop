import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesChatStartPayload } from '../../../../shared/types/hermesChat';

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
  replies: [] as string[],
  startChat: null as unknown as ReturnType<typeof vi.fn>,
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
    const requestId = `req-${n}`;
    const reply = ipc.replies.shift() ?? 'ok';
    setTimeout(() => {
      for (const cb of ipc.chunk) cb({ requestId, delta: reply });
      for (const cb of ipc.end) cb({ requestId });
    }, 0);
    return { success: true, requestId, sessionId: 's1', transport: 'json-rpc' };
  });
  return {
    hermesChatIPC: {
      getHistory: vi.fn().mockResolvedValue({
        success: true,
        sessionId: 's1',
        messages: [
          { role: 'user', content: 'first', rowId: 10, timestamp: 1767225600 },
          { role: 'assistant', content: 'reply one', rowId: 11, timestamp: 1767225610 },
          { role: 'user', content: 'second', rowId: 12, timestamp: 1767225620 },
          { role: 'assistant', content: 'reply two', rowId: 13, timestamp: 1767225630 },
        ],
      }),
      startChat: (...args: unknown[]) => ipc.startChat(...args),
      cancelChat: vi.fn().mockResolvedValue(undefined),
      onChatChunk: on(ipc.chunk),
      onChatEnd: on(ipc.end),
      onChatError: on(ipc.error),
      onChatPhase: unsub,
      onChatTool: unsub,
      onChatApproval: unsub,
      onChatCredentialRequest: unsub,
      listPendingCredentialRequests: async () => [],
      onChatTurnStats: unsub,
      onChatSpeaker: unsub,
      getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
      completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
    },
  };
});

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
}));

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { WorkbenchThread } from '../WorkbenchThread';

const Chat: React.FC<{ isChannel?: boolean }> = ({ isChannel = false }) => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Assistant"
      isChannel={isChannel}
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

const lastPayload = () =>
  ipc.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload | undefined;

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

describe('Edit and Retry', () => {
  beforeEach(() => {
    ipc.replies = [];
    ipc.startChat.mockClear();
  });
  afterEach(() => cleanup());

  it('edits a prompt as a rewind, then retries the new reply', async () => {
    render(<Chat />);
    await screen.findByText('reply two');

    // Both hydrated prompts are on the server, so both can be edited.
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    expect(edits).toHaveLength(2);

    await act(async () => fireEvent.click(edits[1]));
    const editor = (await screen.findByLabelText('Edit message')) as HTMLTextAreaElement;
    expect(editor.value).toBe('second');
    expect(screen.getByText(/Sends as version 2/)).toBeTruthy();

    ipc.replies.push('reply three');
    await act(async () => setValue(editor, 'second, sharper'));
    const form = editor.closest('.wb-editor') as HTMLElement;
    await act(async () => fireEvent.click(within(form).getByRole('button', { name: /Send/ })));

    await screen.findByText('reply three');
    expect(lastPayload()?.rewind).toEqual({ userOrdinal: 1, rowId: 12, expectedText: 'second' });
    expect(lastPayload()?.messages.at(-1)).toEqual({ role: 'user', content: 'second, sharper' });

    const counts = [...document.querySelectorAll('.wb-versions-count')].map((c) => c.textContent);
    expect(counts).toContain('2 / 2');
    expect(screen.getByText('edited')).toBeTruthy();

    // Retry the new reply: same prompt, sent live this session, so no row id yet.
    ipc.replies.push('reply four');
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    await act(async () => fireEvent.click(retries[retries.length - 1]));
    await screen.findByText('reply four');
    expect(lastPayload()?.rewind).toEqual({ userOrdinal: 1, expectedText: 'second, sharper' });
  });

  it('sends a normal message without a rewind', async () => {
    render(<Chat />);
    await screen.findByText('reply two');
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => setValue(input, 'third'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await waitFor(() => expect(ipc.startChat).toHaveBeenCalled());
    expect(lastPayload()?.rewind).toBeUndefined();
  });

  it('offers no Edit or Retry in channels', async () => {
    render(<Chat isChannel />);
    await screen.findByText('reply two');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
