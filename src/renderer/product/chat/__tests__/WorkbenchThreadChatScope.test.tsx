import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ElectronAPI } from '../../../../preload';
import type { FakeBridge, FakeHermesChat } from '../../../__tests__/fakeBridge';
import type {
  HermesChatApprovalEvent,
  HermesChatCredentialRequestEvent,
} from '../../../../shared/types/hermesChat';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';
import { installChatBridge, threadProps } from './threadHarness';

vi.mock('streamdown', () => import('../../../__tests__/streamdownMock'));

let bridge: FakeBridge;
let chat: FakeHermesChat;
let listPendingApprovals: Mock<ElectronAPI['hermesChat']['listPendingApprovals']>;
let listPendingCredentialRequests: Mock<ElectronAPI['hermesChat']['listPendingCredentialRequests']>;

/** Main with chats a and b; the thread runs on a local runtime and takes only events from main. */
function installBridge() {
  listPendingApprovals = vi.fn<ElectronAPI['hermesChat']['listPendingApprovals']>(async () => []);
  listPendingCredentialRequests = vi.fn<ElectronAPI['hermesChat']['listPendingCredentialRequests']>(
    async () => []
  );
  ({ bridge, chat } = installChatBridge('a', {
    hermesChat: { listPendingApprovals, listPendingCredentialRequests },
  }));
}

/** A promise the test resolves, standing in for a pending list main has not answered yet. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

vi.mock('../InferenceChip', () => ({ InferenceChip: (): null => null }));
vi.mock('../ProjectPicker', () => ({ ProjectPicker: (): null => null }));

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
      <WorkbenchThread {...threadProps({ sessionId, agents })} />
    </AssistantRuntimeProvider>
  );
};

const approvalFor = (sessionId: string): HermesChatApprovalEvent => ({
  rpcRequestId: `rpc-${sessionId}`,
  sessionId,
  approvalRequestId: `apr-${sessionId}`,
  command: 'rm -rf scratch',
  toolName: 'terminal',
  choices: ['once', 'session', 'always', 'deny'],
});

describe('WorkbenchThread live turn belongs to the open chat', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it("ignores another chat's speaker event, so that chat's phase stays out", async () => {
    render(<Harness sessionId="b" />);
    await bridge.emit('hermes-chat:speaker', { requestId: 'r1', sessionId: 'a', agentSlug: 'scout' });
    await bridge.emit('hermes-chat:phase', { requestId: 'r1', sessionId: 'a', phase: 'preparing' });
    expect(screen.queryAllByText('Preparing…')).toHaveLength(0);
  });

  it("shows this chat's phase after its speaker event", async () => {
    render(<Harness sessionId="b" />);
    await bridge.emit('hermes-chat:speaker', { requestId: 'r2', sessionId: 'b', agentSlug: 'scout' });
    await bridge.emit('hermes-chat:phase', { requestId: 'r2', sessionId: 'b', phase: 'preparing' });
    expect(screen.queryAllByText('Preparing…').length).toBeGreaterThan(0);
  });
});

describe('WorkbenchThread approvals', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it("does not show another chat's approval or lock this composer", async () => {
    const { container } = render(<Harness sessionId="b" />);
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(container.querySelector('textarea')!.getAttribute('placeholder')).not.toBe(
      'Answer the approval to continue…'
    );
  });

  it("shows this chat's approval, and keeps it when the user comes back from another chat", async () => {
    const { rerender } = render(<Harness sessionId="a" />);
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
    await act(async () => rerender(<Harness sessionId="b" />));
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    await act(async () => rerender(<Harness sessionId="a" />));
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
  });
});

describe('WorkbenchThread pending approvals (G07-5)', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  it("shows the open chat's approval that main parked before this window mounted", async () => {
    listPendingApprovals.mockResolvedValueOnce([approvalFor('a')]);
    await act(async () => {
      render(<Harness sessionId="a" />);
    });
    expect(listPendingApprovals).toHaveBeenLastCalledWith('a');
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeNull();
  });

  it('shows why an answer was not sent, and keeps the card', async () => {
    render(<Harness sessionId="a" />);
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    chat.respondApproval.mockResolvedValueOnce({
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
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    chat.respondApproval.mockResolvedValueOnce({
      success: false,
      error: 'No pending approval for that request',
      errorCode: 'not-pending',
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('replaces a replayed approval with the live request for the same approval', async () => {
    render(<Harness sessionId="a" />);
    await bridge.emit('hermes-chat:approval', { ...approvalFor('a'), rpcRequestId: 'pending:apr-a' });
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(chat.respondApproval).toHaveBeenCalledWith({ rpcRequestId: 'rpc-a', choice: 'deny' });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });
});

describe('WorkbenchThread pending lists that land late (BD-0008)', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

  const createLogin: HermesChatCredentialRequestEvent = {
    rpcRequestId: 'rpc-login',
    sessionId: 'a',
    kind: 'vault.create_login',
    origin: 'https://app.example.com',
    site: 'app.example.com',
    identifier: 'me@example.com',
    regenerate: false,
  };

  it('does not bring back an approval answered while the pending list was loading', async () => {
    const list = deferred<HermesChatApprovalEvent[]>();
    listPendingApprovals.mockReturnValueOnce(list.promise);
    render(<Harness sessionId="a" />);
    await bridge.emit('hermes-chat:approval', approvalFor('a'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    });
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    // Main took this snapshot before the answer reached it.
    await act(async () => list.resolve([approvalFor('a')]));
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('keeps a prompt raised while the list was loading, and drops one a later list leaves out', async () => {
    const list = deferred<HermesChatCredentialRequestEvent[]>();
    listPendingCredentialRequests.mockReturnValueOnce(list.promise);
    const { rerender } = render(<Harness sessionId="a" />);
    await bridge.emit('hermes-chat:credential-request', createLogin);
    // The snapshot predates the prompt, so it leaves it out.
    await act(async () => list.resolve([]));
    expect(screen.queryByText('New login · app.example.com')).not.toBeNull();
    // Main dropped it (timed out) without telling this window; the next list says so.
    await act(async () => rerender(<Harness sessionId="b" />));
    expect(screen.queryByText('New login · app.example.com')).toBeNull();
  });
});

describe('WorkbenchThread @ chip', () => {
  beforeEach(installBridge);
  afterEach(() => {
    cleanup();
    expect(bridge.unfaked).toEqual([]);
  });

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
