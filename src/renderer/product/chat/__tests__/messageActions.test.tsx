import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  HermesChatBreakdownResult,
  HermesChatCredentialRequestEvent,
  HermesProjectRecord,
} from '../../../../shared/types/hermesChat';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type AssistantRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';
import { formatMessageTimeFull } from '../../../../shared/messageTime';
import { toThreadMessage } from '../chatHistoryMessages';

const noop = (): void => undefined;

const readHtmlPreview = vi.hoisted(() => vi.fn());

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

stubElectronAPI({
  hermesChat: {
    readHtmlPreview,
    listPendingCredentialRequests: async (): Promise<HermesChatCredentialRequestEvent[]> => [],
    getContextBreakdown: async (): Promise<HermesChatBreakdownResult> => ({
      success: true,
      breakdown: {
        categories: [],
        contextUsed: 0,
        contextMax: 0,
        contextPercent: 0,
        contextEstimated: false,
      },
    }),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
  projects: {
    completePath: vi.fn().mockResolvedValue({ success: true, items: [] }),
  },
});

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

import { WorkbenchThread } from '../WorkbenchThread';

const sec = (d: Date) => d.getTime() / 1000;

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Harness: React.FC<{
  history: Parameters<typeof toThreadMessage>[0][];
  chatAdapter?: ChatModelAdapter;
  onRuntime?: (runtime: AssistantRuntime) => void;
  project?: HermesProjectRecord | null;
}> = ({ history, chatAdapter = adapter, onRuntime, project = null }) => {
  const runtime = useLocalRuntime(chatAdapter, {
    initialMessages: history.map(toThreadMessage),
  });
  onRuntime?.(runtime);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Assistant"
        activeProject={project}
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

  it('names the writing voice a reply was written in, and nothing on other replies', async () => {
    render(
      <Harness
        history={[
          { role: 'user', content: 'draft it' },
          { role: 'assistant', content: 'voiced', writingVoiceName: 'News' },
          { role: 'user', content: 'and plainly' },
          { role: 'assistant', content: 'plain' },
        ]}
      />
    );
    await screen.findByText('plain');
    const labelled = [...document.querySelectorAll('.wb-msg.is-assistant')].map(
      (m) => m.querySelector('.wb-reply-voice')?.textContent ?? null
    );
    expect(labelled).toEqual(['In News voice', null]);
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

  describe('Preview on the Files line', () => {
    const project: HermesProjectRecord = {
      id: 'p1',
      name: 'Job',
      hostPath: '/Users/me/job',
      containerPath: '/opt/projects/job',
      slug: 'job',
      kind: 'host-folder',
      createdAt: '',
      updatedAt: '',
    };
    const wrote = (files: string[]) => [
      { role: 'user' as const, content: 'make it' },
      { role: 'assistant' as const, content: 'done', files },
    ];

    it('offers Preview for an html file in a bound project', async () => {
      readHtmlPreview.mockResolvedValue({ success: true, html: '<p>x</p>', name: 'page.html' });
      render(
        <Harness
          project={project}
          history={wrote(['/opt/projects/job/out/page.html', '/opt/projects/job/notes.md'])}
        />
      );
      await screen.findByText('out/page.html');
      expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Reveal' })).toHaveLength(2);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      });
      expect(readHtmlPreview).toHaveBeenCalledWith({
        containerPath: '/opt/projects/job/out/page.html',
      });
    });

    it('lists only previewable /opt/projects files when no project is bound', async () => {
      readHtmlPreview.mockResolvedValue({ success: true, html: '<p>x</p>', name: 'demo.html' });
      render(
        <Harness
          history={wrote([
            '/opt/projects/scratch/demo.html',
            '/opt/projects/scratch/n.md',
            '/opt/data/x.html',
          ])}
        />
      );
      await screen.findByText('scratch/demo.html');
      expect(document.querySelectorAll('.wb-file')).toHaveLength(1);
      expect(screen.getAllByRole('button', { name: 'Preview' })).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Reveal' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
      });
      expect(readHtmlPreview).toHaveBeenCalledWith({
        containerPath: '/opt/projects/scratch/demo.html',
      });
    });

    it('renders nothing without a project when no file is previewable', async () => {
      render(<Harness history={wrote(['/opt/projects/scratch/n.md', '/opt/data/x.html'])} />);
      await screen.findByText('done');
      expect(document.querySelector('.wb-files')).toBeNull();
    });

    it('hides the strip while the reply runs', async () => {
      let release: () => void = noop;
      const running: ChatModelAdapter = {
        async *run() {
          yield {
            content: [{ type: 'text' as const, text: 'partial' }],
            metadata: { custom: { files: ['/opt/projects/scratch/live.html'] } },
          };
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      };
      let runtime: AssistantRuntime | null = null;
      render(
        <Harness
          history={[{ role: 'user', content: 'go', timestamp: 100 }]}
          chatAdapter={running}
          onRuntime={(r) => {
            runtime = r;
          }}
        />
      );
      await screen.findByText('go');
      await act(async () => {
        runtime?.thread.startRun({ parentId: runtime.thread.getState().messages[0].id });
      });
      await screen.findByText('partial');
      expect(document.querySelector('.wb-files')).toBeNull();
      await act(async () => release());
      await screen.findByText('scratch/live.html');
    });
  });
});
