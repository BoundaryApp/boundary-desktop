import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';
import {
  formatDayLabel,
  formatMessageTime,
  formatMessageTimeFull,
  toUnixSeconds,
} from '../../../../shared/messageTime';
import { messageTimeMs, needsDayDivider } from '../messageMeta';
import { toThreadMessage } from '../HermesChatRuntimeProvider';

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

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  return {
    hermesChatIPC: {
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

import { WorkbenchThread } from '../WorkbenchThread';

const sec = (d: Date) => d.getTime() / 1000;

describe('messageTime', () => {
  it('coerces seconds, ms and date strings to unix seconds', () => {
    expect(toUnixSeconds(1767225600)).toBe(1767225600);
    expect(toUnixSeconds(1767225600000)).toBe(1767225600);
    expect(toUnixSeconds('1767225600')).toBe(1767225600);
    expect(toUnixSeconds('2026-01-01T00:00:00.000Z')).toBe(1767225600);
    expect(toUnixSeconds(null)).toBeNull();
    expect(toUnixSeconds('soon')).toBeNull();
    expect(toUnixSeconds(0)).toBeNull();
  });

  it('labels days relative to now', () => {
    const now = new Date(2026, 8, 29, 14, 0).getTime();
    expect(formatDayLabel(new Date(2026, 8, 29, 1, 0).getTime(), now, 'en-US')).toBe('Today');
    expect(formatDayLabel(new Date(2026, 8, 28, 23, 0).getTime(), now, 'en-US')).toBe(
      'Yesterday'
    );
    expect(formatDayLabel(new Date(2026, 8, 21, 9, 0).getTime(), now, 'en-US')).toBe(
      'Monday, September 21'
    );
    expect(formatDayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now, 'en-US')).toBe(
      'Wednesday, December 31, 2025'
    );
  });

  it('formats a short time and a full tooltip', () => {
    const ms = new Date(2026, 8, 29, 14, 14, 8).getTime();
    expect(formatMessageTime(ms, 'en-US')).toBe('2:14 PM');
    expect(formatMessageTimeFull(ms, 'en-US')).toBe(
      'Tuesday, September 29, 2026 at 2:14:08 PM'
    );
  });
});

describe('messageMeta', () => {
  it('prefers the stored time and never falls back to load time for history', () => {
    const loadedAt = new Date(2026, 8, 29, 9, 0);
    expect(messageTimeMs({ createdAt: loadedAt, metadata: { custom: { ts: 100 } } })).toBe(
      100_000
    );
    expect(messageTimeMs({ createdAt: loadedAt, metadata: { custom: { ts: null } } })).toBeNull();
    expect(messageTimeMs({ createdAt: loadedAt })).toBe(loadedAt.getTime());
    expect(messageTimeMs(undefined)).toBeNull();
  });

  it('puts a divider on the first timed message and at each new local day', () => {
    const mon = new Date(2026, 8, 28, 23, 0).getTime();
    const tue = new Date(2026, 8, 29, 1, 0).getTime();
    expect(needsDayDivider(0, tue, null)).toBe(true);
    expect(needsDayDivider(3, tue, mon)).toBe(true);
    expect(needsDayDivider(3, tue, tue + 60_000)).toBe(false);
    expect(needsDayDivider(3, tue, null)).toBe(false);
    expect(needsDayDivider(0, null, null)).toBe(false);
  });

  it('hydrates history rows with an explicit time slot', () => {
    expect(toThreadMessage({ role: 'user', content: 'hi', timestamp: 100, rowId: 7 }, 0)).toEqual({
      id: 'hist-0',
      role: 'user',
      content: 'hi',
      createdAt: new Date(100_000),
      metadata: { custom: { ts: 100, rowId: 7 } },
    });
    expect(toThreadMessage({ role: 'assistant', content: 'yo' }, 1)).toEqual({
      id: 'hist-1',
      role: 'assistant',
      content: 'yo',
      metadata: { custom: { ts: null, rowId: null } },
    });
  });
});

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Harness: React.FC<{
  history: Parameters<typeof toThreadMessage>[0][];
  chatAdapter?: ChatModelAdapter;
  onRuntime?: (runtime: AssistantRuntime) => void;
}> = ({ history, chatAdapter = adapter, onRuntime }) => {
  const runtime = useLocalRuntime(chatAdapter, {
    initialMessages: history.map(toThreadMessage),
  });
  onRuntime?.(runtime);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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
    </AssistantRuntimeProvider>
  );
};

describe('transcript message rows', () => {
  afterEach(() => cleanup());

  it('renders right-aligned prompts with time, copy and day dividers', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(16, 52, 0, 0);
    const today = new Date();
    today.setHours(0, 5, 0, 0);
    render(
      <Harness
        history={[
          { role: 'user', content: 'first', timestamp: sec(yesterday) },
          { role: 'assistant', content: 'reply one', timestamp: sec(yesterday) + 10 },
          { role: 'user', content: 'second', timestamp: sec(today) },
          { role: 'assistant', content: 'reply two', timestamp: sec(today) + 10 },
        ]}
      />
    );
    await screen.findByText('reply two');

    const prompt = screen.getByText('second').closest('.wb-msg');
    expect(prompt?.classList.contains('is-user')).toBe(true);
    expect(prompt?.querySelector('.wb-who')).toBeNull();
    expect(prompt?.querySelector('time.wb-msg-time')?.getAttribute('title')).toBe(
      formatMessageTimeFull(today.getTime())
    );

    expect(screen.getAllByRole('separator').map((d) => d.textContent)).toEqual([
      'Yesterday',
      'Today',
    ]);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(4);

    const replies = document.querySelectorAll('.wb-msg.is-assistant .wb-acts');
    expect(replies[0].classList.contains('is-pinned')).toBe(false);
    expect(replies[1].classList.contains('is-pinned')).toBe(true);
  });

  it('shows no row on a reply that is still streaming', async () => {
    let release: () => void = noop;
    const streaming: ChatModelAdapter = {
      async *run() {
        yield { content: [{ type: 'text' as const, text: 'partial' }] };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    let runtime: AssistantRuntime | null = null;
    render(
      <Harness
        history={[{ role: 'user', content: 'go', timestamp: 100 }]}
        chatAdapter={streaming}
        onRuntime={(r) => {
          runtime = r;
        }}
      />
    );
    await screen.findByText('go');
    await act(async () => {
      runtime?.thread.startRun({ parentId: runtime.thread.getState().messages[0].id });
    });
    const partial = await screen.findByText('partial');
    expect(partial.closest('.wb-msg')?.querySelector('.wb-acts')).toBeNull();

    await act(async () => release());
    const done = await screen.findByText('partial');
    expect(done.closest('.wb-msg')?.querySelector('.wb-acts.is-pinned')).not.toBeNull();
  });

  it('says "No tools used" only on replies known to have run none', async () => {
    render(
      <Harness
        history={[
          { role: 'user', content: 'make a file' },
          { role: 'assistant', content: 'claimed it', toolCount: 0 },
          { role: 'user', content: 'really?' },
          { role: 'assistant', content: 'used tools', toolCount: 2 },
          { role: 'user', content: 'and from webui?' },
          { role: 'assistant', content: 'unknown' },
        ]}
      />
    );
    await screen.findByText('unknown');
    const labelled = [...document.querySelectorAll('.wb-msg.is-assistant')].filter((m) =>
      m.querySelector('.wb-no-tools')
    );
    expect(labelled.map((m) => m.querySelector('.wb-prose')?.textContent)).toEqual([
      'claimed it',
    ]);
  });

  it('passes invented tags to the renderer escaped, so they show as text', async () => {
    render(
      <Harness
        history={[
          { role: 'user', content: 'make a file' },
          { role: 'assistant', content: '<action>Write file</action> <kbd>ok</kbd>' },
        ]}
      />
    );
    expect(await screen.findByText('\\<action>Write file\\</action> <kbd>ok</kbd>')).toBeTruthy();
  });

  it('collapses a long prompt behind Show more, and leaves short ones alone', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('wb-bubble-body') && this.textContent?.includes('LONG')
          ? 2000
          : 40;
      },
    });
    try {
      render(
        <Harness
          history={[
            { role: 'user', content: 'LONG pasted document' },
            { role: 'assistant', content: 'read it' },
            { role: 'user', content: 'short prompt' },
            { role: 'assistant', content: 'ok' },
          ]}
        />
      );
      await screen.findByText('ok');
      const [long, short] = [...document.querySelectorAll('.wb-msg.is-user .wb-bubble')];
      expect(long.classList.contains('is-collapsed')).toBe(true);
      expect(short.classList.contains('is-collapsed')).toBe(false);
      expect(short.querySelector('.wb-show-more')).toBeNull();

      const toggle = screen.getByRole('button', { name: 'Show more' });
      await act(async () => fireEvent.click(toggle));
      expect(long.classList.contains('is-collapsed')).toBe(false);
      expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    }
  });

  it('shows no time or divider for history without stored times', async () => {
    render(
      <Harness
        history={[
          { role: 'user', content: 'untimed' },
          { role: 'assistant', content: 'also untimed' },
        ]}
      />
    );
    await screen.findByText('also untimed');
    expect(document.querySelectorAll('time.wb-msg-time')).toHaveLength(0);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
