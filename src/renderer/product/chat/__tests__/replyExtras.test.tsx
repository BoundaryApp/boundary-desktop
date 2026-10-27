import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  HermesChatStartPayload,
  HermesProjectRecord,
} from '../../../../shared/types/hermesChat';

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
  saveReply: null as unknown as ReturnType<typeof vi.fn>,
  revealProjectFile: null as unknown as ReturnType<typeof vi.fn>,
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};
// Runs stay open until a test replies to them (`reply`). Main answers with the adapter's id.
ipc.startChat = vi.fn(async (payload: { requestId: string }) => {
  ipc.active = payload.requestId;
  return { success: true, requestId: ipc.active, sessionId: 's1' };
});
ipc.saveReply = vi.fn(async () => ({ success: true, path: '/Users/ada/Job Search/plan.md' }));
ipc.revealProjectFile = vi.fn(async () => ({ success: true }));

stubElectronAPI({
  hermesChat: {
    getHistory: ipcCalls.track(vi.fn().mockResolvedValue({
      success: true,
      sessionId: 's1',
      messages: [
        { role: 'user', content: 'Plan my week', rowId: 1 },
        {
          role: 'assistant',
          content: '## Plan\n\n- **Mon:** write',
          rowId: 2,
          files: [
            '/opt/projects/job-search/plan.md',
            '/opt/projects/other/elsewhere.md',
            'relative.md',
          ],
        },
      ],
    })),
    startChat: ipcCalls.track((...args: unknown[]) => ipc.startChat(...args)),
    saveReply: ipcCalls.track((...args: unknown[]) => ipc.saveReply(...args)),
    revealProjectFile: ipcCalls.track((...args: unknown[]) => ipc.revealProjectFile(...args)),
    cancelChat: vi.fn(),
    onChatChunk: on(ipc.chunk as Set<Listener>),
    onChatEnd: on(ipc.end as Set<Listener>),
    onChatTool: on(ipc.tool as Set<Listener>),
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

const project = {
  id: 'p1',
  name: 'Job Search',
  hostPath: '/Users/ada/Job Search',
  containerPath: '/opt/projects/job-search',
} as HermesProjectRecord;

const Chat: React.FC<{ withProject?: boolean }> = ({ withProject = true }) => (
  <HermesChatRuntimeProvider sessionId="s1">
    <WorkbenchThread
      sessionId="s1"
      threadTitle="Assistant"
      activeProject={withProject ? project : null}
      projects={withProject ? [project] : []}
      activeProjectId={withProject ? 'p1' : null}
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
async function renderChat(props: { withProject?: boolean } = {}) {
  render(<Chat {...props} />);
  await ipcCalls.settle();
}

/** Hermes answers the open run with `text` and ends it. */
const reply = (text: string) =>
  act(async () => {
    for (const cb of ipc.chunk) cb({ requestId: ipc.active, delta: text });
    for (const cb of ipc.end) cb({ requestId: ipc.active });
  });

const writeText = vi.fn(async () => undefined);
const lastSent = () =>
  (ipc.startChat.mock.calls.at(-1)?.[0] as HermesChatStartPayload).messages.at(-1)?.content;

const setValue = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  fireEvent.input(el);
};

const openMenu = async () => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'More' })));
};

describe('Reply extras', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.active = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(async () => {
    await ipcCalls.settle();
    cleanup();
  });

  it('copies a reply as plain text', async () => {
    await renderChat();
    await openMenu();
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: /Copy as plain text/ }))
    );
    expect(writeText).toHaveBeenCalledWith('Plan\n\n• Mon: write');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('quotes a reply above what you type, and the quote can be removed', async () => {
    await renderChat();
    await openMenu();
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Quote in reply/ })));
    expect(document.querySelector('.wb-quote p')?.textContent).toBe('## Plan\n\n- **Mon:** write');

    // Removing it means nothing is quoted.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Remove quote' })));
    expect(document.querySelector('.wb-quote')).toBeNull();

    await openMenu();
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: /Quote in reply/ })));
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => setValue(input, 'Make Monday lighter.'));
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await ipcCalls.settle();
    expect(lastSent()).toBe('> ## Plan\n>\n> - **Mon:** write\n\nMake Monday lighter.');
    expect(document.querySelector('.wb-quote')).toBeNull();
    await reply('noted');
    expect(screen.getByText('noted')).toBeTruthy();

    // The sent prompt shows the quote as a block above what was typed.
    const bubbles = document.querySelectorAll('.wb-msg.is-user .wb-bubble');
    const sent = bubbles[bubbles.length - 1];
    expect(sent.querySelector('.wb-user-quote')?.textContent).toBe('## Plan\n\n- **Mon:** write');
    expect(sent.querySelector('p')?.textContent).toBe('Make Monday lighter.');
  });

  it('saves a reply to the project and says where', async () => {
    await renderChat();
    await openMenu();
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: /Save to Job Search/ }))
    );
    expect(ipc.saveReply).toHaveBeenCalledWith({
      projectId: 'p1',
      content: '## Plan\n\n- **Mon:** write',
    });
    await ipcCalls.settle();
    expect(screen.getByText('Saved plan.md')).toBeTruthy();
  });

  it('offers no Save without a project', async () => {
    await renderChat({ withProject: false });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Save to/ })).toBeNull();
  });

  it('reveals only tool paths inside the project (while the turn is live)', async () => {
    await renderChat();
    await act(async () => {
      // Tool cards are progress (ADR 0006): they show while a turn is running.
      for (const cb of ipc.phase) cb({ requestId: 'r1', sessionId: 's1', phase: 'tool' });
      for (const cb of ipc.tool) {
        cb({
          requestId: 'r1',
          toolId: 't1',
          name: 'write_file',
          status: 'done',
          paths: ['/opt/projects/job-search/letters/acme.md', 'notes.md'],
        });
      }
    });
    const card = await waitFor(() => {
      const el = document.querySelector('.wb-tool');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const reveal = within(card).getAllByRole('button', { name: 'Reveal' });
    expect(reveal).toHaveLength(1);
    await act(async () => fireEvent.click(reveal[0]));
    expect(ipc.revealProjectFile).toHaveBeenCalledWith({
      projectId: 'p1',
      relativePath: 'letters/acme.md',
    });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Copy path' })));
    expect(writeText).toHaveBeenCalledWith('/Users/ada/Job Search/letters/acme.md');
  });

  it('lists the files a finished reply wrote inside the project', async () => {
    await renderChat();
    const files = document.querySelector('.wb-files') as HTMLElement;
    expect(files).not.toBeNull();
    expect([...files.querySelectorAll('.wb-file .mono')].map((f) => f.textContent)).toEqual([
      'plan.md',
    ]);
    await act(async () => fireEvent.click(within(files).getByRole('button', { name: 'Reveal' })));
    expect(ipc.revealProjectFile).toHaveBeenCalledWith({ projectId: 'p1', relativePath: 'plan.md' });
  });

  it('shows no Files line without a project', async () => {
    await renderChat({ withProject: false });
    expect(document.querySelector('.wb-files')).toBeNull();
  });
});
