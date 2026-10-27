import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  HermesChatMessage,
  HermesChatStartPayload,
  HermesNoReply,
} from '../../../../shared/types/hermesChat';

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

type Listener = (event: {
  requestId: string;
  delta?: string;
  error?: string;
  noReply?: HermesNoReply;
}) => void;
const ipc = vi.hoisted(() => ({
  chunk: new Set<Listener>(),
  end: new Set<Listener>(),
  error: new Set<Listener>(),
  history: [] as HermesChatMessage[],
  active: null as string | null,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
  getHistory: null as unknown as ReturnType<typeof vi.fn>,
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};
// Main answers with the request id the adapter sent.
ipc.startChat = vi.fn(async (payload: { requestId: string }) => {
  ipc.active = payload.requestId;
  return { success: true, requestId: ipc.active, sessionId: 's1' };
});
ipc.getHistory = vi.fn(async () => ({ success: true, sessionId: 's1', messages: ipc.history }));

stubElectronAPI({
  hermesChat: {
    getHistory: (...args: unknown[]) => ipc.getHistory(...args),
    startChat: (...args: unknown[]) => ipc.startChat(...args),
    cancelChat: vi.fn().mockResolvedValue({ success: true }),
    onChatChunk: on(ipc.chunk),
    onChatEnd: on(ipc.end),
    onChatError: on(ipc.error),
    listPendingCredentialRequests: async () => [],
    listRunningTurns: async () => [],
    getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
  projects: {
    completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
  },
});

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { WorkbenchThread } from '../WorkbenchThread';
import { setRunningTurnsForTests } from '../runningTurns';
import { noReplyText } from '../TurnNotes';

const Chat: React.FC = () => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Hermes"
      agents={[]}
      activeProject={null}
      projects={[]}
      activeProjectId={null}
      toolsEnabled
      onToolsEnabledChange={noop}
      onSelectProject={noop}
      onClearProject={noop}
      onNewProject={noop}
    />
  </HermesChatRuntimeProvider>
);

const asked: HermesChatMessage = { role: 'user', content: 'Where do cron scripts live?', rowId: 7 };
const running = (requestId: string) =>
  setRunningTurnsForTests([
    { requestId, sessionIds: ['s1'], agentSlug: null, startedAt: new Date(Date.now() - 95_000).toISOString() },
  ]);

const input = () => screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

describe('turn notes', () => {
  beforeEach(() => {
    ipc.history = [];
    ipc.active = null;
    ipc.startChat.mockClear();
    ipc.getHistory.mockClear();
    setRunningTurnsForTests([]);
  });
  afterEach(() => {
    cleanup();
    setRunningTurnsForTests([]);
  });

  it('says why a reopened chat has no reply, and Retry reruns that message', async () => {
    ipc.history = [{ ...asked, noReply: { reason: 'failed', error: 'rate limited' } }];
    render(<Chat />);
    expect(await screen.findByText(/couldn’t reply/)).toBeTruthy();
    expect(screen.getByText(/rate limited/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    const payload = ipc.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload;
    expect(payload.rewind).toEqual(expect.objectContaining({ rowId: 7 }));
    expect(payload.messages).toEqual([{ role: 'user', content: 'Where do cron scripts live?' }]);
  });

  it('calls an unanswered message with no note what it is', async () => {
    ipc.history = [asked];
    render(<Chat />);
    expect(await screen.findByText('No reply to this message')).toBeTruthy();
  });

  it('shows a turn still running from before, then loads its reply in place', async () => {
    ipc.history = [asked];
    running('req-away');
    render(<Chat />);
    // The same compact form as a kanban task running for as long.
    expect(await screen.findByText(/is still working · 1m$/)).toBeTruthy();
    expect(screen.queryByText('No reply to this message')).toBeNull();
    await act(async () => setValue(input(), 'half-typed follow-up'));

    ipc.history = [asked, { role: 'assistant', content: 'In /etc/cron.d.', rowId: 8 }];
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
    await waitFor(() => expect(ipc.active).not.toBeNull());
    const requestId = ipc.active!;
    await act(async () => running(requestId));

    await act(async () => {
      for (const cb of ipc.end) cb({ requestId, noReply: { reason: 'halted' } });
    });
    await act(async () => setRunningTurnsForTests([]));

    expect(await screen.findByText(/stopped without replying/)).toBeTruthy();
    expect(ipc.getHistory).toHaveBeenCalledTimes(1);
  });
});

describe('turn note copy', () => {
  it('names each way a reply can fail to arrive', () => {
    expect(noReplyText('stopped', 'Iris')).toBe('Stopped before Iris replied');
    expect(noReplyText('timeout', 'Iris')).toBe('No reply after 3 minutes');
    expect(noReplyText('unknown', 'Iris')).toBe('No reply to this message');
  });
});
