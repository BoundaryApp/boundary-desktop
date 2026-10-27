import React, { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

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

type Listener = (event: Record<string, unknown>) => void;
const ipc = vi.hoisted(() => ({
  chunk: new Set<(e: Record<string, unknown>) => void>(),
  end: new Set<(e: Record<string, unknown>) => void>(),
  phase: new Set<(e: Record<string, unknown>) => void>(),
  getHistory: null as unknown as ReturnType<typeof vi.fn>,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};
ipc.getHistory = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
  success: true,
  sessionId,
  messages: [],
}));
// A DM placeholder gets its real session on the first send.
ipc.startChat = vi.fn(async ({ requestId }: { requestId: string }) => ({
  success: true,
  requestId,
  sessionId: 'real-1',
}));

stubElectronAPI({
  hermesChat: {
    getHistory: ipcCalls.track((...args: unknown[]) => ipc.getHistory(...args)),
    startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
    cancelChat: vi.fn(),
    onChatChunk: on(ipc.chunk as Set<Listener>),
    onChatEnd: on(ipc.end as Set<Listener>),
    onChatPhase: on(ipc.phase as Set<Listener>),
    listPendingCredentialRequests: ipcCalls.track(async () => []),
    getContextBreakdown: ipcCalls.track(vi.fn().mockResolvedValue({ success: false })),
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

/** The open chat, swapping to a resolved id the way WorkbenchChatScreen does. */
const Chat: React.FC<{ initialId: string }> = ({ initialId }) => {
  const [id, setId] = useState(initialId);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const sameChat = useCallback(
    (a: string, b: string) => a === b || (aliases[a] ?? a) === (aliases[b] ?? b),
    [aliases]
  );
  const resolved = useCallback((next: string) => {
    setId((current) => {
      if (current !== next) setAliases((prev) => ({ ...prev, [next]: prev[current] ?? current }));
      return next;
    });
  }, []);
  return (
    <HermesChatRuntimeProvider sessionId={id} onSessionResolved={resolved} sameChat={sameChat}>
      <WorkbenchThread
        sessionId={id}
        sameChat={sameChat}
        threadTitle="Orchestrator"
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
};

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

const phase = (event: Record<string, unknown>) =>
  act(async () => {
    for (const cb of ipc.phase) cb(event);
  });

describe('a chat that gets its session on the first send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
  });

  it('keeps the sent prompt and the live turn when the real id comes back', async () => {
    render(<Chat initialId="placeholder-1" />);
    await ipcCalls.settle();

    const input = screen.getByPlaceholderText(/Message/) as HTMLTextAreaElement;
    await act(async () => setValue(input, 'Put a task on the board'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();

    expect(ipc.startChat).toHaveBeenCalledTimes(1);
    // The chat adopted its real id in place: no reload that would wipe the turn.
    expect(ipc.getHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Loading chat…')).toBeNull();
    expect(screen.getByText('Put a task on the board')).toBeTruthy();

    const { requestId } = ipc.startChat.mock.calls[0]![0] as { requestId: string };
    await phase({ requestId, sessionId: 'real-1', phase: 'preparing' });
    expect(screen.getAllByText('Preparing…').length).toBeGreaterThan(0);

    await act(async () => {
      for (const cb of ipc.chunk) cb({ requestId, delta: 'On the board.' });
      for (const cb of ipc.end) cb({ requestId });
    });
    expect(screen.getByText('On the board.')).toBeTruthy();
  });
});

describe("another chat's turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
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
