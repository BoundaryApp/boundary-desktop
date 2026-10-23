import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

const noop = () => undefined;
globalThis.ResizeObserver ??= class {
  observe = noop;
  unobserve = noop;
  disconnect = noop;
} as unknown as typeof ResizeObserver;
Element.prototype.scrollTo ??= noop;

const streamdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => {
    streamdownRenders.count += 1;
    return <div>{children}</div>;
  },
}));

vi.mock('../../../services/hermesChatIPCService', () => {
  const unsub = () => () => undefined;
  return {
    hermesChatIPC: {
      onChatPhase: unsub,
      onChatTool: unsub,
      onChatApproval: unsub,
      onChatCredentialRequest: unsub,
      listPendingCredentialRequests: vi.fn(async () => []),
      respondCredentialRequest: vi.fn(async () => ({ success: true })),
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
import { hermesChatIPC } from '../../../services/hermesChatIPCService';

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Harness: React.FC<{ initialMessages?: { role: 'user' | 'assistant'; content: string }[] }> = ({
  initialMessages,
}) => {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Assistant"
        activeProject={null}
        projects={[]}
        activeProjectId={null}
        toolsEnabled
        onToolsEnabledChange={() => undefined}
        onSelectProject={() => undefined}
        onClearProject={() => undefined}
        onNewProject={() => undefined}
        onCreateAgentFromDraft={() => undefined}
        onEditAgentDraft={() => undefined}
      />
    </AssistantRuntimeProvider>
  );
};

const setNativeValue = (el: HTMLTextAreaElement, value: string, caret: number) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    el,
    value
  );
  el.setSelectionRange(caret, caret);
};

describe('WorkbenchThread composer', () => {
  afterEach(() => cleanup());

  it('keeps the caret where the user typed mid-text', async () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;

    await act(async () => {
      setNativeValue(input, 'hello world', 11);
      fireEvent.input(input);
    });

    // Click back to after "hello" and type one character.
    await act(async () => {
      setNativeValue(input, 'helloX world', 6);
      fireEvent.input(input);
    });

    expect(input.value).toBe('helloX world');
    expect(input.selectionStart).toBe(6);
  });

  it('does not re-render messages when the parent re-renders with fresh callbacks', async () => {
    const initialMessages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: '**hello**' },
      { role: 'user' as const, content: 'again' },
      { role: 'assistant' as const, content: '**hello again**' },
    ];
    const { rerender } = render(<Harness initialMessages={initialMessages} />);
    await screen.findByText('**hello again**');

    const before = streamdownRenders.count;
    rerender(<Harness initialMessages={initialMessages} />);

    expect(streamdownRenders.count).toBe(before);
  });
});

describe('WorkbenchThread draft card', () => {
  afterEach(() => cleanup());

  it('shows the card in place of the raw agent-draft fence', async () => {
    const reply = [
      'Here is a draft.',
      '',
      '```agent-draft',
      'displayName: Staff Recruiter',
      'handle: staff-recruiter',
      'role: Own outreach.',
      '```',
    ].join('\n');
    render(
      <Harness
        initialMessages={[
          { role: 'user', content: 'draft one' },
          { role: 'assistant', content: reply },
        ]}
      />
    );

    expect(await screen.findByText('Staff Recruiter')).toBeTruthy();
    expect(screen.getByText('Here is a draft.')).toBeTruthy();
    expect(screen.queryByText(/agent-draft/)).toBeNull();
  });
});

describe('WorkbenchThread credential prompt', () => {
  afterEach(() => cleanup());

  it('shows a prompt that was still waiting when the thread mounted', async () => {
    vi.mocked(hermesChatIPC.listPendingCredentialRequests).mockResolvedValueOnce([
      { rpcRequestId: 'rpc-9', sessionId: 'runtime-1', kind: 'secret', envVar: 'GITHUB_TOKEN' },
    ]);
    render(<Harness />);
    expect(await screen.findByText('Secret needed · GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByPlaceholderText('Answer the prompt above to continue…')).toBeTruthy();
  });

  it('after saving a login, links to it in Passwords & Logins', async () => {
    vi.mocked(hermesChatIPC.listPendingCredentialRequests).mockResolvedValueOnce([
      {
        rpcRequestId: 'rpc-10',
        sessionId: 'runtime-1',
        kind: 'vault.save_login',
        origin: 'https://www.linkedin.com',
        site: 'www.linkedin.com',
      },
    ]);
    const opened = vi.fn();
    window.addEventListener('boundary:open-settings', (e) => opened((e as CustomEvent).detail));
    render(<Harness />);
    await screen.findByText('Save login · www.linkedin.com');
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    });

    expect(hermesChatIPC.respondCredentialRequest).toHaveBeenCalledWith({
      rpcRequestId: 'rpc-10',
      login: { identifier: 'me@example.com', password: 'hunter2' },
    });
    expect((await screen.findByText(/Saved the login for/)).textContent).toContain('www.linkedin.com');
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Passwords & Logins' }));
    expect(opened).toHaveBeenCalledWith({ tab: 'passwords', agentSlug: 'assistant' });
  });
});
