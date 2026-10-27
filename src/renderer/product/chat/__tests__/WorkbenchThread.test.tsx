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

const streamdownRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => {
    streamdownRenders.count += 1;
    return <div>{children}</div>;
  },
}));

stubElectronAPI({
  hermesChat: {
    listPendingCredentialRequests: vi.fn(async () => []),
    respondCredentialRequest: vi.fn(async () => ({ success: true })),
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

// The chip reports Local as unreachable until the thread asks it to re-resolve.
const chip = vi.hoisted(() => ({ afterRefresh: null as unknown }));
vi.mock('../InferenceChip', async () => {
  const { useEffect } = await import('react');
  return {
    InferenceChip: ({
      refreshKey = 0,
      onResolvedChange,
    }: {
      refreshKey?: number;
      onResolvedChange?: (resolved: unknown) => void;
    }) => {
      useEffect(() => {
        onResolvedChange?.(
          refreshKey > 0 && chip.afterRefresh
            ? chip.afterRefresh
            : chip.afterRefresh
              ? { slot: 'local', modelId: 'qwen3:14b', health: 'unreachable', provenance: 'app-default', configured: true }
              : null
        );
      }, [refreshKey, onResolvedChange]);
      return null;
    },
  };
});
vi.mock('../ProjectPicker', () => ({ ProjectPicker: () => null }));

import { WorkbenchThread } from '../WorkbenchThread';
import { HermesChatRuntimeProvider } from '../HermesChatRuntimeProvider';
import { takeInferenceStatus } from '../../../onboarding/inferenceStatus';

const adapter = {
  async *run() {
    yield { content: [{ type: 'text' as const, text: 'ok' }] };
  },
};

const Harness: React.FC<{
  initialMessages?: { role: 'user' | 'assistant'; content: string }[];
  chatAdapter?: typeof adapter;
  connecting?: boolean;
}> = ({ initialMessages, chatAdapter = adapter, connecting = false }) => {
  const runtime = useLocalRuntime(chatAdapter, { initialMessages });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkbenchThread
        sessionId="s1"
        threadTitle="Assistant"
        connecting={connecting}
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

  it('locks the composer while the folder connects, as it disables the input', async () => {
    const { container } = render(<Harness connecting />);
    const input = screen.getByPlaceholderText('Connecting folder…') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(container.querySelector('.wb-composer')?.classList.contains('is-locked')).toBe(true);
  });

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

describe('WorkbenchThread failed send (decision D3)', () => {
  afterEach(() => cleanup());

  it('shows why a reply failed, with Retry that runs it again', async () => {
    let runs = 0;
    const flaky = {
      async *run() {
        runs += 1;
        if (runs === 1) throw new Error("Couldn't reach the assistant stack: connect ECONNREFUSED.");
        yield { content: [{ type: 'text' as const, text: 'back again' }] };
      },
    };
    render(<Harness chatAdapter={flaky} />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'hello', 5);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't reach the assistant stack/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
    expect(await screen.findByText('back again')).toBeTruthy();
    expect(runs).toBe(2);
  });
});

describe('WorkbenchThread offline prompt', () => {
  afterEach(() => {
    cleanup();
    chip.afterRefresh = null;
  });

  it('after Send via OpenRouter, the next Enter sends without the prompt', async () => {
    chip.afterRefresh = {
      slot: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      provenance: 'chat-override',
      configured: true,
    };
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    stubElectronAPI({ hermesChat: { setSessionInference } });
    await takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'local',
        slots: {
          local: { configured: true, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
    render(<Harness />);
    const input = screen.getByPlaceholderText('Message Hermes…') as HTMLTextAreaElement;
    const type = async (text: string) =>
      act(async () => {
        setNativeValue(input, text, text.length);
        fireEvent.input(input);
      });

    await type('first');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send via OpenRouter' })));
    expect(setSessionInference).toHaveBeenCalledWith({
      sessionId: 's1',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
    });
    expect(screen.queryByText(/Local model unreachable/)).toBeNull();

    await type('second');
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(screen.queryByText(/Local model unreachable/)).toBeNull();
  });

  it('in a chat with no session yet, Send via OpenRouter sends with the override', async () => {
    chip.afterRefresh = {
      slot: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4',
      provenance: 'chat-override',
      configured: true,
    };
    const setSessionInference = vi.fn().mockResolvedValue({ success: true });
    // The reply never streams; the turn ends when the test unmounts the chat.
    const startChat = vi.fn(async (payload: { requestId: string }) => ({
      success: true,
      requestId: payload.requestId,
      sessionId: 's-new',
    }));
    stubElectronAPI({ hermesChat: { setSessionInference, startChat } });
    await takeInferenceStatus({
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'local',
        slots: {
          local: { configured: true, modelId: 'qwen3:14b' },
          openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' },
        },
      },
    });
    render(
      <HermesChatRuntimeProvider sessionId={null}>
        <WorkbenchThread
          sessionId={null}
          threadTitle="New chat"
          kind="hermes"
          activeProject={null}
          projects={[]}
          activeProjectId={null}
          toolsEnabled
          onToolsEnabledChange={noop}
          onSelectProject={noop}
          onClearProject={noop}
          onNewProject={noop}
        />
      </HermesChatRuntimeProvider>
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(input, 'first', 5);
      fireEvent.input(input);
    });
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }));
    expect(startChat).not.toHaveBeenCalled();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send via OpenRouter' })));
    expect(setSessionInference).not.toHaveBeenCalled();
    expect(startChat).toHaveBeenCalledTimes(1);
    expect(startChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        sessionId: undefined,
        messages: [{ role: 'user', content: 'first' }],
        inference: { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      })
    );
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
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([
      { rpcRequestId: 'rpc-9', sessionId: 'runtime-1', kind: 'secret', envVar: 'GITHUB_TOKEN' },
    ]);
    render(<Harness />);
    expect(await screen.findByText('Secret needed · GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByPlaceholderText('Answer the prompt above to continue…')).toBeTruthy();
  });

  it('after saving a login, links to it in Passwords & Logins', async () => {
    vi.mocked(window.electronAPI.hermesChat.listPendingCredentialRequests).mockResolvedValueOnce([
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

    expect(window.electronAPI.hermesChat.respondCredentialRequest).toHaveBeenCalledWith({
      rpcRequestId: 'rpc-10',
      login: { identifier: 'me@example.com', password: 'hunter2' },
    });
    expect((await screen.findByText(/Saved the login for/)).textContent).toContain('www.linkedin.com');
    fireEvent.click(screen.getByRole('button', { name: 'Manage in Passwords & Logins' }));
    expect(opened).toHaveBeenCalledWith({ tab: 'passwords', agentSlug: 'assistant' });
  });
});
