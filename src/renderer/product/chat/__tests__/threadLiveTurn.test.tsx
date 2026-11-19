import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBridge } from '../../../__tests__/fakeBridge';
import type {
  HermesChatBreakdownResult,
  HermesChatContextFile,
} from '../../../../shared/types/hermesChat';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { installChatBridge, threadProps } from './threadHarness';

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

let bridge: FakeBridge;
let contextFiles: HermesChatContextFile[] = [];

function installBridge() {
  ({ bridge } = installChatBridge('s1', {
    hermesChat: {
      getContextBreakdown: async (): Promise<HermesChatBreakdownResult> => ({
        success: true,
        breakdown: {
          categories: [],
          contextUsed: 10,
          contextMax: 100,
          contextPercent: 10,
          contextEstimated: false,
          contextFiles,
        },
      }),
    },
  }));
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

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
        {...threadProps({ sessionId: 's1', activeProject: project, projects: [project], activeProjectId: 'p1' })}
      />
    </AssistantRuntimeProvider>
  );
};

const turn = { requestId: 'r1', sessionId: 's1' };

describe('WorkbenchThread live tool cards', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    contextFiles = [];
    expect(bridge.unfaked).toEqual([]);
  });

  it('shows the context files on a finished tool card while the model restarts', async () => {
    render(<Harness />);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'preparing' });
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'tool', toolName: 'read_file' });
    await bridge.emit('hermes-chat:tool', { ...turn, toolId: 't1', name: 'read_file', status: 'done' });
    contextFiles = [
      {
        label: 'plan.md',
        path: '/work/notes/plan.md',
        chars: 400,
        estTokens: 100,
        loaded: true,
        status: '',
      },
    ];
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'done' });
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'restarting' });
    const path = await screen.findByText('plan.md');
    expect(within(path.closest('li')!).getByText('Reveal')).toBeTruthy();
  });

  it('shows Hermes’s recovery wait in place of Preparing, and drops it when the turn ends', async () => {
    render(<Harness />);
    const wait = { provider: 'OpenRouter', cycle: 2, total: 5, retryInSec: 30 };
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'preparing', elapsedSec: 40, recovery: wait });
    const line = "OpenRouter isn't responding. Retrying in 30s (2 of 5)";
    expect((await screen.findAllByText(line)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Preparing/)).toBeNull();
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'preparing', elapsedSec: 71, recovery: { ...wait, retryInSec: 0 } });
    expect((await screen.findAllByText("OpenRouter isn't responding. Retrying now (2 of 5)")).length).toBeGreaterThan(0);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'done' });
    expect(screen.queryByText(/isn't responding/)).toBeNull();
  });

  it('drops the Preparing line when a stopped turn ends', async () => {
    render(<Harness />);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'preparing' });
    expect((await screen.findAllByText('Preparing…')).length).toBeGreaterThan(0);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'done' });
    expect(screen.queryAllByText('Preparing…')).toEqual([]);
  });

  it('keeps Reveal on paths when a tool completes without its arguments', async () => {
    render(<Harness />);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'tool', toolName: 'write_file' });
    await bridge.emit('hermes-chat:tool', {
      ...turn,
      toolId: 't1',
      name: 'write_file',
      status: 'running',
      paths: ['/work/notes/draft.md'],
    });
    await bridge.emit('hermes-chat:tool', { ...turn, toolId: 't1', name: 'write_file', status: 'done', paths: [] });
    const path = await screen.findByText('draft.md');
    expect(within(path.closest('li')!).getByText('Reveal')).toBeTruthy();
  });

  it('drops the generating card once the tool it announced starts', async () => {
    const { container } = render(<Harness />);
    await bridge.emit('hermes-chat:phase', { ...turn, phase: 'tool', toolName: 'write_file' });
    await bridge.emit('hermes-chat:tool', {
      ...turn,
      toolId: 'generating-write_file',
      name: 'write_file',
      status: 'generating',
    });
    expect(container.querySelectorAll('.wb-tool')).toHaveLength(1);
    await bridge.emit('hermes-chat:tool', { ...turn, toolId: 't1', name: 'write_file', status: 'running' });
    await bridge.emit('hermes-chat:tool', { ...turn, toolId: 't1', name: 'write_file', status: 'done' });
    expect(container.querySelectorAll('.wb-tool')).toHaveLength(1);
    expect(container.querySelectorAll('.wb-tool .wb-spin')).toHaveLength(0);
  });
});
