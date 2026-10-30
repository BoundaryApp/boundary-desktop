import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

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

stubElectronAPI({
  hermesChat: {
    listPendingApprovals: vi.fn(async () => []),
    listPendingCredentialRequests: vi.fn(async () => []),
    getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
  },
});

const chip = vi.hoisted(() => ({ marks: [] as unknown[] }));
vi.mock('../InferenceChip', async () => {
  const { useEffect } = await import('react');
  return {
    InferenceChip: ({ onMarksChange }: { onMarksChange?: (marks: unknown[]) => void }) => {
      useEffect(() => onMarksChange?.(chip.marks), [onMarksChange]);
      return null;
    },
  };
});
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import type { SessionProjectMark } from '../../../../shared/types/hermesChat';

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const at = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 20, hour, minute));

const messages = [
  { role: 'user' as const, content: 'first question', createdAt: at(9) },
  { role: 'assistant' as const, content: 'first answer', createdAt: at(10) },
  { role: 'user' as const, content: 'second question', createdAt: at(12) },
  { role: 'assistant' as const, content: 'second answer', createdAt: at(13) },
];

const projects = [
  { id: 'p1', name: 'Atlas', hostPath: '/Users/example/Atlas', containerPath: '/work/atlas' },
  { id: 'p2', name: 'Beacon', hostPath: '/Users/example/Beacon', containerPath: '/work/beacon' },
] as never[];

const move = (id: string, when: string, toProjectId: string): SessionProjectMark => ({
  id,
  at: when,
  kind: 'moved',
  fromProjectId: null,
  toProjectId,
});

const Harness: React.FC<{ projectMarks: SessionProjectMark[] }> = ({ projectMarks }) => {
  const runtime = useLocalRuntime(adapter, { initialMessages: messages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        kind="hermes"
        threadTitle="Plan"
        activeProject={null}
        projects={projects}
        activeProjectId={null}
        projectMarks={projectMarks}
        toolsEnabled
        onToolsEnabledChange={noop}
        onSelectProject={noop}
        onClearProject={noop}
        onNewProject={noop}
      />
    </AssistantRuntimeProvider>
  );
};

const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING);

describe('transcript marks', () => {
  afterEach(() => {
    cleanup();
    chip.marks = [];
  });

  it('draws each mark between the messages it happened between', async () => {
    chip.marks = [
      { id: 'i1', at: at(11).toISOString(), kind: 'switched', provider: 'openrouter', modelId: 'x/model-a' },
    ];
    render(<Harness projectMarks={[move('m1', at(9, 30).toISOString(), 'p2')]} />);
    const firstQuestion = await screen.findByText('first question');
    const firstAnswer = screen.getByText('first answer');
    const secondQuestion = screen.getByText('second question');
    const moved = document.querySelector('.wb-project-mark')!;
    const switched = await screen.findByText(/^Switched to /);
    expect(follows(moved, firstQuestion)).toBe(true);
    expect(follows(firstAnswer, moved)).toBe(true);
    expect(follows(switched, firstAnswer)).toBe(true);
    expect(follows(secondQuestion, switched)).toBe(true);
  });

  it('says which provider answered when a fallback did (ADR 0033 §3)', async () => {
    chip.marks = [
      { id: 'f1', at: at(11).toISOString(), kind: 'fell-back', provider: 'openrouter', modelId: 'x/model-a' },
    ];
    render(<Harness projectMarks={[]} />);
    expect(await screen.findByText('Answered by OpenRouter · model-a, a fallback')).toBeTruthy();
  });

  it('names who shared the model when a shared model answered', async () => {
    chip.marks = [
      {
        id: 'f1',
        at: at(11).toISOString(),
        kind: 'fell-back',
        provider: 'peer',
        modelId: 'qwen3:14b',
        sharedBy: { person: 'Ada', circle: 'Friends' },
      },
    ];
    render(<Harness projectMarks={[]} />);
    expect(await screen.findByText('Answered by qwen3:14b, shared by Ada in Friends, a fallback')).toBeTruthy();
  });

  it('draws a mark newer than every message after the last one', async () => {
    render(<Harness projectMarks={[move('m1', at(14).toISOString(), 'p2')]} />);
    const lastAnswer = await screen.findByText('second answer');
    const moved = document.querySelector('.wb-project-mark')!;
    expect(follows(moved, lastAnswer)).toBe(true);
  });

  it('leaves out a mark with no time', async () => {
    render(<Harness projectMarks={[move('m1', '', 'p2')]} />);
    await screen.findByText('second answer');
    expect(document.querySelector('.wb-project-mark')).toBeNull();
  });
});
