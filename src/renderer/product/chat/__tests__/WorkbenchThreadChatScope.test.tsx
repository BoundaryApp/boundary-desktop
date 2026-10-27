import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  speaker: new Set<(event: Record<string, unknown>) => void>(),
  approval: new Set<(event: Record<string, unknown>) => void>(),
}));

const on = (set: Set<Listener>) => (cb: Listener) => {
  set.add(cb);
  return () => set.delete(cb);
};

const api = stubElectronAPI({
  hermesChat: {
    listPendingApprovals: vi.fn(async () => []),
    onChatPhase: on(ipc.phase),
    onChatApproval: on(ipc.approval),
    listPendingCredentialRequests: vi.fn(async () => []),
    respondCredentialRequest: vi.fn(async () => ({ success: true })),
    respondApproval: vi.fn(async () => ({ success: true })),
    ackApproval: vi.fn(async () => ({ success: true })),
    onChatSpeaker: on(ipc.speaker),
    getContextBreakdown: async () => ({ success: true, breakdown: { categories: [] } }),
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

const agents = [
  { slug: 'scout', displayName: 'Scout', handle: 'scout', role: 'Researcher', builtIn: false },
] as never;

const Harness: React.FC<{ sessionId: string | null }> = ({ sessionId }) => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId={sessionId}
        threadTitle="Assistant"
        agents={agents}
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

const emit = (set: Set<Listener>, event: Record<string, unknown>) =>
  act(async () => {
    for (const cb of [...set]) cb(event);
  });

const approvalFor = (sessionId: string) => ({
  rpcRequestId: `rpc-${sessionId}`,
  sessionId,
  approvalRequestId: `apr-${sessionId}`,
  command: 'rm -rf scratch',
  toolName: 'terminal',
  choices: ['once', 'session', 'always', 'deny'],
});

describe('WorkbenchThread live turn belongs to the open chat', () => {
  afterEach(() => cleanup());

  it("ignores another chat's speaker event, so that chat's phase stays out", async () => {
    render(<Harness sessionId="b" />);
    await emit(ipc.speaker, { requestId: 'r1', sessionId: 'a', agentSlug: 'scout' });
    await emit(ipc.phase, { requestId: 'r1', sessionId: 'a', phase: 'preparing' });
    expect(screen.queryAllByText('Preparing…')).toHaveLength(0);
  });

  it("shows this chat's phase after its speaker event", async () => {
    render(<Harness sessionId="b" />);
    await emit(ipc.speaker, { requestId: 'r2', sessionId: 'b', agentSlug: 'scout' });
    await emit(ipc.phase, { requestId: 'r2', sessionId: 'b', phase: 'preparing' });
    expect(screen.queryAllByText('Preparing…').length).toBeGreaterThan(0);
  });
});

describe('WorkbenchThread approvals', () => {
  afterEach(() => cleanup());

  it("does not show another chat's approval or lock this composer", async () => {
    const { container } = render(<Harness sessionId="b" />);
    await emit(ipc.approval, approvalFor('a'));
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(container.querySelector('textarea')!.getAttribute('placeholder')).not.toBe(
      'Answer the approval to continue…'
    );
  });

  it("shows this chat's approval, and keeps it when the user comes back from another chat", async () => {
    const { rerender } = render(<Harness sessionId="a" />);
    await emit(ipc.approval, approvalFor('a'));
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
    await act(async () => rerender(<Harness sessionId="b" />));
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    await act(async () => rerender(<Harness sessionId="a" />));
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
  });
});

describe('WorkbenchThread pending approvals (G07-5)', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(api.hermesChat.respondApproval).mockReset();
    vi.mocked(api.hermesChat.respondApproval).mockResolvedValue({ success: true });
  });

  it("shows the open chat's approval that main parked before this window mounted", async () => {
    vi.mocked(api.hermesChat.listPendingApprovals).mockResolvedValueOnce([approvalFor('a')] as never);
    await act(async () => {
      render(<Harness sessionId="a" />);
    });
    expect(api.hermesChat.listPendingApprovals).toHaveBeenLastCalledWith('a');
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
  });

  it('shows why an answer was not sent, and keeps the card', async () => {
    render(<Harness sessionId="a" />);
    await emit(ipc.approval, approvalFor('a'));
    vi.mocked(api.hermesChat.respondApproval).mockResolvedValueOnce({
      success: false,
      error: 'The connection to the assistant stack dropped, so that answer was not sent.',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/was not sent/);
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
  });

  it('drops the card when main no longer holds the approval', async () => {
    render(<Harness sessionId="a" />);
    await emit(ipc.approval, approvalFor('a'));
    vi.mocked(api.hermesChat.respondApproval).mockResolvedValueOnce({
      success: false,
      error: 'No pending approval for that request',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('replaces a replayed approval with the live request for the same approval', async () => {
    render(<Harness sessionId="a" />);
    await emit(ipc.approval, { ...approvalFor('a'), rpcRequestId: 'pending:apr-a' });
    await emit(ipc.approval, approvalFor('a'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(api.hermesChat.respondApproval).toHaveBeenCalledWith({ rpcRequestId: 'rpc-a', choice: 'deny' });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});

describe('WorkbenchThread @ chip', () => {
  afterEach(() => cleanup());

  it('inserts the mention picked from the list it opens', async () => {
    const { container } = render(<Harness sessionId="b" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '@' }));
    });
    const option = await screen.findByRole('option', { name: /Scout/ });
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('@Scout ');
  });

  it('adds the mention after text already typed', async () => {
    const { container } = render(<Harness sessionId="b" />);
    const input = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'ask'
      );
      input.setSelectionRange(3, 3);
      fireEvent.input(input);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '@' }));
    });
    const option = await screen.findByRole('option', { name: /Scout/ });
    await act(async () => {
      fireEvent.mouseDown(option);
    });
    expect(input.value).toBe('ask @Scout ');
  });
});
