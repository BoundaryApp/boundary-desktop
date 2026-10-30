import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
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

type Listener = (event: Record<string, unknown>) => void;
const ipc = vi.hoisted(() => ({
  phase: new Set<(event: Record<string, unknown>) => void>(),
  tool: new Set<(event: Record<string, unknown>) => void>(),
  breakdown: { contextFiles: [] as { path: string }[] },
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};

stubElectronAPI({
  hermesChat: {
    listPendingApprovals: vi.fn(async () => []),
    listPendingCredentialRequests: vi.fn(async () => []),
    onChatPhase: on(ipc.phase),
    onChatTool: on(ipc.tool),
    getContextBreakdown: async () => ({
      success: true,
      breakdown: {
        categories: [],
        contextUsed: 10,
        contextMax: 100,
        contextPercent: 10,
        contextEstimated: false,
        contextFiles: ipc.breakdown.contextFiles,
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
vi.mock('../InferenceChip', () => ({ InferenceChip: () => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { WorkbenchThread } from '../WorkbenchThread';

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const project = {
  id: 'p1',
  name: 'Notes',
  hostPath: '/Users/example/Notes',
  containerPath: '/work/notes',
} as never;

const Harness: React.FC = () => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Assistant"
        activeProject={project}
        projects={[project]}
        activeProjectId="p1"
        toolsEnabled
        onToolsEnabledChange={noop}
        onSelectProject={noop}
        onClearProject={noop}
        onNewProject={noop}
      />
    </AssistantRuntimeProvider>
  );
};

const emit = (set: Set<Listener>, event: Record<string, unknown>) =>
  act(async () => {
    for (const cb of [...set]) cb(event);
  });

const turn = { requestId: 'r1', sessionId: 's1' };

describe('WorkbenchThread live tool cards', () => {
  afterEach(() => {
    cleanup();
    ipc.breakdown.contextFiles = [];
  });

  it('shows the context files on a finished tool card while the model restarts', async () => {
    render(<Harness />);
    await emit(ipc.phase, { ...turn, phase: 'preparing' });
    await emit(ipc.phase, { ...turn, phase: 'tool', toolName: 'read_file' });
    await emit(ipc.tool, { ...turn, toolId: 't1', name: 'read_file', status: 'done' });
    ipc.breakdown.contextFiles = [{ path: '/work/notes/plan.md' }];
    await emit(ipc.phase, { ...turn, phase: 'done' });
    await emit(ipc.phase, { ...turn, phase: 'restarting' });
    const path = await screen.findByText('plan.md');
    expect(within(path.closest('li')!).getByText('Reveal')).toBeTruthy();
  });

  it('drops the Preparing line when a stopped turn ends', async () => {
    render(<Harness />);
    await emit(ipc.phase, { ...turn, phase: 'preparing' });
    expect((await screen.findAllByText('Preparing…')).length).toBeGreaterThan(0);
    await emit(ipc.phase, { ...turn, phase: 'done' });
    expect(screen.queryAllByText('Preparing…')).toEqual([]);
  });

  it('keeps Reveal on paths when a tool completes without its arguments', async () => {
    render(<Harness />);
    await emit(ipc.phase, { ...turn, phase: 'tool', toolName: 'write_file' });
    await emit(ipc.tool, {
      ...turn,
      toolId: 't1',
      name: 'write_file',
      status: 'running',
      paths: ['/work/notes/draft.md'],
    });
    await emit(ipc.tool, { ...turn, toolId: 't1', name: 'write_file', status: 'done', paths: [] });
    const path = await screen.findByText('draft.md');
    expect(within(path.closest('li')!).getByText('Reveal')).toBeTruthy();
  });

  it('drops the generating card once the tool it announced starts', async () => {
    const { container } = render(<Harness />);
    await emit(ipc.phase, { ...turn, phase: 'tool', toolName: 'write_file' });
    await emit(ipc.tool, {
      ...turn,
      toolId: 'generating-write_file',
      name: 'write_file',
      status: 'generating',
    });
    expect(container.querySelectorAll('.wb-tool')).toHaveLength(1);
    await emit(ipc.tool, { ...turn, toolId: 't1', name: 'write_file', status: 'running' });
    await emit(ipc.tool, { ...turn, toolId: 't1', name: 'write_file', status: 'done' });
    expect(container.querySelectorAll('.wb-tool')).toHaveLength(1);
    expect(container.querySelectorAll('.wb-tool .wb-spin')).toHaveLength(0);
  });
});
