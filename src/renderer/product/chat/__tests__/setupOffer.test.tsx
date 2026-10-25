import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  tool: new Set<(e: Record<string, unknown>) => void>(),
  phase: new Set<(e: Record<string, unknown>) => void>(),
  active: null as string | null,
  startChat: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  const on = (set: Set<Listener>) => (cb: Listener) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  let n = 0;
  // Runs stay open until a test replies to them (`reply`).
  ipc.startChat = vi.fn(async () => {
    n += 1;
    ipc.active = `req-${n}`;
    return { success: true, requestId: ipc.active, sessionId: 's1', transport: 'json-rpc' };
  });
  return {
    hermesChatIPC: {
      getHistory: ipcCalls.track(vi.fn().mockResolvedValue({
        success: true,
        sessionId: 's1',
        messages: [],
      })),
      startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
      cancelChat: vi.fn(),
      onChatChunk: on(ipc.chunk as Set<Listener>),
      onChatEnd: on(ipc.end as Set<Listener>),
      onChatTool: on(ipc.tool as Set<Listener>),
      onChatError: unsub,
      onChatPhase: on(ipc.phase as Set<Listener>),
      onChatApproval: unsub,
      onChatCredentialRequest: unsub,
      listPendingCredentialRequests: ipcCalls.track(async () => []),
      onChatTurnStats: unsub,
      onChatSpeaker: unsub,
      getContextBreakdown: ipcCalls.track(vi.fn().mockResolvedValue({ success: false })),
      completePath: ipcCalls.track(vi.fn().mockResolvedValue({ success: true, items: [] })),
    },
  };
});

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: ipcCalls.track(vi.fn().mockResolvedValue({ configured: true, slots: {} })),
    probeSlotHealth: ipcCalls.track(vi.fn().mockResolvedValue({ health: 'reachable' })),
  },
}));

const calendars = vi.hoisted(() => ({ accounts: [] as unknown[] }));
vi.mock('../../../services/calendarIPCService', () => ({
  calendarIPC: {
    list: ipcCalls.track(async () => ({ success: true, accounts: calendars.accounts })),
    onChanged: () => () => undefined,
  },
}));

vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { WorkbenchThread } from '../WorkbenchThread';
import { resetSetupOffersForTests } from '../setupOffers';

const Chat: React.FC = () => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Assistant"
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

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

/**
 * Sends `text`, then Hermes runs `tool` (if any) and replies. Hermes decides whether to call
 * offer_setup; these tests stand in for that choice and check what Boundary does with it.
 */
async function ask(text: string, tool: { name: string; args?: Record<string, unknown> } | null, answer: string) {
  const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
  await act(async () => setValue(input, text));
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
  await ipcCalls.settle();
  await act(async () => {
    for (const cb of ipc.phase) cb({ requestId: ipc.active, sessionId: 's1', phase: 'preparing' });
    if (tool) {
      for (const cb of ipc.tool) {
        cb({ requestId: ipc.active, sessionId: 's1', toolId: 't1', name: tool.name, status: 'running', args: tool.args });
        cb({ requestId: ipc.active, sessionId: 's1', toolId: 't1', name: tool.name, status: 'done', args: tool.args });
      }
    }
    for (const cb of ipc.chunk) cb({ requestId: ipc.active, delta: answer });
    for (const cb of ipc.end) cb({ requestId: ipc.active });
  });
  await ipcCalls.settle();
}

const card = () => screen.queryByRole('group', { name: 'Connect a calendar' });
const OFFER = { name: 'mcp_boundary_offer_setup', args: { kind: 'calendar' } };

describe('Connect a calendar card (calendar spec 3.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.active = null;
    calendars.accounts = [];
    resetSetupOffersForTests();
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
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
    calendars.accounts = [{ slug: 'personal', name: 'Personal' }];
    render(<Chat />);
    await ipcCalls.settle();
    expect(card()).toBeNull();
  });
});
