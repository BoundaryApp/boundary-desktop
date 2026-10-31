import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantRuntimeProvider, useLocalRuntime, type ThreadRuntime } from '@assistant-ui/react';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

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
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

const getSessionInference = vi.fn();

stubElectronAPI({
  hermesChat: {
    listPendingApprovals: vi.fn(async () => []),
    listPendingCredentialRequests: vi.fn(async () => []),
    getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
    getSessionInference: (...args: unknown[]) => getSessionInference(...args),
  },
  onboarding: {
    getStatus: vi.fn().mockResolvedValue({ configured: true, slots: {} }),
    probeSlotHealth: vi.fn().mockResolvedValue({ health: 'reachable' }),
    onStatus: () => noop,
  },
});

import { WorkbenchThread } from '../WorkbenchThread';

// Each turn stays running until the test ends it, so the screen sees it start and stop.
const turn = { finish: noop };
const adapter = {
  async *run() {
    await new Promise<void>((resolve) => (turn.finish = resolve));
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const snapshot = (marks: unknown[]) => ({
  success: true,
  override: null,
  resolved: {
    slot: 'openrouter',
    modelId: 'x/primary',
    providerDisplayName: 'OpenRouter',
    provenance: 'app-default',
    configured: true,
    needsRestart: false,
    fallbacks: [{ slot: 'peer', modelId: 'qwen3:14b', peer: { circleId: 'c1', providerId: 'p1' } }],
  },
  marks,
});

const fellBack = {
  id: 'f1',
  at: new Date(Date.now() + 1_000).toISOString(),
  kind: 'fell-back',
  provider: 'peer',
  modelId: 'qwen3:14b',
  sharedBy: { person: 'Ada', circle: 'Friends' },
};
const recovered = {
  id: 'r1',
  at: new Date(Date.now() + 2_000).toISOString(),
  kind: 'recovered',
  provider: 'openrouter',
  modelId: 'x/primary',
};

const thread = { current: null as ThreadRuntime | null };

const Harness: React.FC = () => {
  const runtime = useLocalRuntime(adapter);
  thread.current = runtime.thread;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        kind="hermes"
        threadTitle="Plan"
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        projectMarks={[]}
        toolsEnabled
        onToolsEnabledChange={noop}
        onSelectProject={noop}
        onClearProject={noop}
        onNewProject={noop}
      />
    </AssistantRuntimeProvider>
  );
};

async function sendTurn(text: string) {
  await act(async () => {
    thread.current!.append(text);
  });
  await waitFor(() => expect(thread.current!.getState().isRunning).toBe(true));
  await act(async () => turn.finish());
}

describe('the chip across a run of turns', () => {
  beforeEach(() => {
    getSessionInference.mockReset();
  });
  afterEach(cleanup);

  it('follows the answering model, and the transcript says when it changed', async () => {
    getSessionInference.mockResolvedValue(snapshot([]));
    render(<Harness />);
    await screen.findByRole('button', { name: /Inference · OpenRouter · primary/ });

    getSessionInference.mockResolvedValue(snapshot([fellBack]));
    await sendTurn('first');
    await screen.findByRole('button', { name: /Inference · Ada's qwen3:14b · fallback for OpenRouter · primary/ });
    expect(await screen.findByText('Answered by qwen3:14b, shared by Ada in Friends, a fallback')).toBeTruthy();

    // A run on the same fallback adds no mark; the chip stays on it.
    await sendTurn('second');
    await screen.findByRole('button', { name: /Inference · Ada's qwen3:14b/ });

    getSessionInference.mockResolvedValue(snapshot([fellBack, recovered]));
    await sendTurn('third');
    const chip = await screen.findByRole('button', { name: /Inference · OpenRouter · primary/ });
    expect(chip.textContent).toBe('OpenRouter · primary');
    expect(await screen.findByText('Back on OpenRouter · primary')).toBeTruthy();
  });
});
