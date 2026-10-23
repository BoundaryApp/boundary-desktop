import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const history = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  branch: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  return {
    hermesChatIPC: {
      getHistory: vi.fn(async () => ({
        success: true,
        sessionId: 's1',
        messages: history.messages,
        ...(history.branch ? { branch: history.branch } : {}),
      })),
      startChat: vi.fn(),
      cancelChat: vi.fn(),
      onChatChunk: unsub,
      onChatEnd: unsub,
      onChatError: unsub,
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
import { WorkbenchThread, type BranchedFrom } from '../WorkbenchThread';
import { branchRequestAt, type BranchRequest } from '../MessageActions';

const text = (role: string, t: string) => ({ role, content: [{ type: 'text', text: t }] });

describe('branchRequestAt', () => {
  const path = [
    text('user', 'first'),
    text('assistant', 'reply one'),
    text('user', 'second'),
    text('assistant', 'reply two'),
  ];

  it('from a prompt: the messages above it, with the prompt as the draft', () => {
    expect(branchRequestAt(path, 2)).toEqual({
      seed: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply one' },
      ],
      draft: 'second',
    });
  });

  it('from a reply: everything through it, no draft', () => {
    expect(branchRequestAt(path, 1)).toEqual({
      seed: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply one' },
      ],
    });
  });

  it('from the first prompt: an empty seed and the prompt as the draft', () => {
    expect(branchRequestAt(path, 0)).toEqual({ seed: [], draft: 'first' });
  });

  it('drops empty and non-chat messages', () => {
    expect(
      branchRequestAt(
        [text('system', 'rules'), text('user', 'hi'), text('assistant', ''), text('assistant', 'ok')],
        3
      ).seed
    ).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});

const Chat: React.FC<{
  onBranch?: (request: BranchRequest) => void;
  branchedFrom?: BranchedFrom | null;
  initialDraft?: string | null;
  onDraftConsumed?: () => void;
  isChannel?: boolean;
}> = ({ onBranch, branchedFrom = null, initialDraft = null, onDraftConsumed, isChannel }) => (
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
      onBranch={onBranch}
      branchedFrom={branchedFrom}
      initialDraft={initialDraft}
      onDraftConsumed={onDraftConsumed}
    />
  </HermesChatRuntimeProvider>
);

describe('Branch in the thread', () => {
  afterEach(() => {
    cleanup();
    history.branch = undefined;
  });

  it('asks to branch from a prompt with the history above it', async () => {
    history.messages = [
      { role: 'user', content: 'first', rowId: 1 },
      { role: 'assistant', content: 'reply one', rowId: 2 },
      { role: 'user', content: 'second', rowId: 3 },
      { role: 'assistant', content: 'reply two', rowId: 4 },
    ];
    const onBranch = vi.fn();
    render(<Chat onBranch={onBranch} />);
    await screen.findByText('reply two');

    const buttons = screen.getAllByRole('button', { name: 'Branch to new chat' });
    expect(buttons).toHaveLength(4);
    await act(async () => fireEvent.click(buttons[2]));
    expect(onBranch).toHaveBeenCalledWith({
      seed: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply one' },
      ],
      draft: 'second',
    });
  });

  it('hides Branch in channels', async () => {
    history.messages = [
      { role: 'user', content: 'hello', rowId: 1 },
      { role: 'assistant', content: 'hi', rowId: 2 },
    ];
    render(<Chat onBranch={vi.fn()} isChannel />);
    await screen.findByText('hi');
    expect(screen.queryByRole('button', { name: 'Branch to new chat' })).toBeNull();
  });

  it('shows where a branch came from, without times on the copied messages', async () => {
    history.messages = [
      { role: 'user', content: 'first', rowId: 1, timestamp: 1767225600 },
      { role: 'assistant', content: 'reply one', rowId: 2, timestamp: 1767225600 },
    ];
    history.branch = { parentId: 'p1', seededCount: 2, branchedAt: '2026-09-30T10:00:00.000Z' };
    const onOpenParent = vi.fn();
    const onDraftConsumed = vi.fn();
    render(
      <Chat
        onBranch={vi.fn()}
        branchedFrom={{
          parentTitle: 'Draft outreach',
          branchedAt: '2026-09-30T10:00:00.000Z',
          seededCount: 2,
          onOpenParent,
          justBranched: true,
          onDismissToast: noop,
        }}
        initialDraft="second"
        onDraftConsumed={onDraftConsumed}
      />
    );
    await screen.findByText('reply one');

    expect(document.querySelectorAll('time.wb-msg-time')).toHaveLength(0);
    expect(document.querySelector('.wb-branch-mark')?.textContent).toMatch(
      /^Branched from Draft outreach · /
    );
    expect(screen.getByText('Branched into a new chat')).toBeTruthy();

    const composer = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    expect(composer.value).toBe('second');
    expect(onDraftConsumed).toHaveBeenCalledTimes(1);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Go back' })));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'from Draft outreach' }))
    );
    expect(onOpenParent).toHaveBeenCalledTimes(2);
  });
});
