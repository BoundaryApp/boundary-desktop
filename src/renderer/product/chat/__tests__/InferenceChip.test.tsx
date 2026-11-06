import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { InferenceChip } from '../InferenceChip';

const getStatus = vi.fn();
const probeSlotHealth = vi.fn();
const getSessionInference = vi.fn();
const setSessionInference = vi.fn();
const clearSessionInference = vi.fn();
// The status main pushes when a slot's health changes.
const pushStatus = vi.hoisted(() => ({ current: null as ((status: unknown) => void) | null }));

stubElectronAPI({
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
    onStatus: (cb: (status: unknown) => void) => {
      pushStatus.current = cb;
      return () => undefined;
    },
  },
  hermesChat: {
    getSessionInference: (...args: unknown[]) => getSessionInference(...args),
    setSessionInference: (...args: unknown[]) => setSessionInference(...args),
    clearSessionInference: (...args: unknown[]) => clearSessionInference(...args),
  },
});

const bothConfigured = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: {
    local: {
      configured: true,
      modelId: 'qwen3:14b',
      health: 'reachable' as const,
    },
    openrouter: {
      configured: true,
      modelId: 'anthropic/claude-sonnet-4',
      health: 'reachable' as const,
    },
  },
};

/** The menu's "This chat tries, in order" rows, first to last. */
const order = () => within(screen.getByRole('list', { name: 'This chat tries, in order' })).getAllByRole('listitem');

describe('InferenceChip', () => {
  afterEach(() => {
    cleanup();
  });

  it('in a private project, disables the cloud and says why a cloud chat can’t send', async () => {
    getSessionInference.mockResolvedValue({
      success: true,
      override: { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
      resolved: {
        slot: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        providerDisplayName: 'OpenRouter',
        provenance: 'chat-override',
        configured: true,
        needsRestart: false,
        privacyLocked: true,
        privacyRefused: true,
      },
      marks: [],
    });
    render(<InferenceChip sessionId="s1" />);
    const trigger = await screen.findByRole('button', { name: /not private, can’t send/ });
    fireEvent.click(trigger);
    expect(order()[0].textContent).toMatch(/OpenRouter.*not private, can’t send/);
    // The chat's own stack can't start on the cloud here: main refuses it (ADR 0033 §4).
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    expect(await screen.findByText('This project is private, so the first model must be Local.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add model' }) as HTMLButtonElement).disabled).toBe(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getStatus.mockResolvedValue(bothConfigured);
    probeSlotHealth.mockResolvedValue({ success: true, health: 'reachable' });
    getSessionInference.mockResolvedValue({
      success: true,
      override: null,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        health: 'reachable',
        needsRestart: false,
      },
      marks: [],
    });
    setSessionInference.mockImplementation(async (payload: { provider: string; modelId: string }) => ({
      success: true,
      override: { provider: payload.provider, modelId: payload.modelId },
      resolved: {
        slot: payload.provider,
        modelId: payload.modelId,
        providerDisplayName: payload.provider === 'local' ? 'Local' : 'OpenRouter',
        provenance: 'chat-override',
        configured: true,
        needsRestart: true,
      },
      marks: [
        {
          id: 'm1',
          at: '2026-09-28T00:00:00.000Z',
          kind: 'switched',
          provider: payload.provider,
          modelId: payload.modelId,
        },
      ],
    }));
    clearSessionInference.mockResolvedValue({
      success: true,
      override: null,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
      marks: [],
    });
  });

  it('names a shared model rather than a provider, and marks it in the menu (ADR 0036)', async () => {
    getStatus.mockResolvedValue({ configured: true, encryptionAvailable: true, appDefault: null, slots: {} });
    getSessionInference.mockResolvedValue({
      success: true,
      override: null,
      resolved: {
        slot: 'peer',
        modelId: 'qwen3-8b',
        providerDisplayName: "Bo's qwen3-8b",
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
      marks: [],
    });
    render(<InferenceChip sessionId="s1" />);
    const chip = await screen.findByRole('button', { name: /Bo's qwen3-8b/ });
    expect(probeSlotHealth).not.toHaveBeenCalled();
    fireEvent.click(chip);
    await screen.findByText('This chat tries, in order');
    expect(order()[0].textContent).toMatch(/Bo's qwen3-8b.*shared in your Circle/);
  });

  describe('when a fallback answered', () => {
    const peer = { circleId: 'c1', providerId: 'p1' };
    const sharedMark = {
      id: 'f1',
      at: '2026-10-31T10:00:00.000Z',
      kind: 'fell-back',
      provider: 'peer',
      modelId: 'qwen3-8b',
      sharedBy: { person: 'Bo', circle: 'Friends' },
    };
    const onOpenRouter = (marks: unknown[], extra: Record<string, unknown> = {}) => ({
      success: true,
      override: null,
      resolved: {
        slot: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        providerDisplayName: 'OpenRouter',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
        fallbacks: [{ slot: 'peer', modelId: 'qwen3-8b', peer }],
        ...extra,
      },
      marks,
    });

    it('names the shared model with a marker and keeps the primary in the menu', async () => {
      getSessionInference.mockResolvedValue(onOpenRouter([sharedMark]));
      render(<InferenceChip sessionId="s1" />);
      const chip = await screen.findByRole('button', {
        name: "Inference · Bo's qwen3-8b · fallback for OpenRouter · claude-sonnet-4",
      });
      expect(chip.textContent).toBe("Bo's qwen3-8bfallback");
      fireEvent.click(chip);
      expect(await screen.findByText('Answering now')).toBeTruthy();
      expect(order().map((row) => row.textContent)).toEqual([
        expect.stringMatching(/^1OpenRouter · claude-sonnet-4/),
        expect.stringMatching(/^2.*qwen3-8b.*shared in your Circle/),
      ]);
    });

    it('returns to the primary when a refresh finds it answered again', async () => {
      getSessionInference.mockResolvedValue(onOpenRouter([sharedMark]));
      const { rerender } = render(<InferenceChip sessionId="s1" refreshKey={0} />);
      await screen.findByRole('button', { name: /Bo's qwen3-8b/ });
      getSessionInference.mockResolvedValue(
        onOpenRouter([
          sharedMark,
          { ...sharedMark, id: 'r1', kind: 'recovered', provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' },
        ])
      );
      rerender(<InferenceChip sessionId="s1" refreshKey={1} />);
      const chip = await screen.findByRole('button', { name: /Inference · OpenRouter · claude-sonnet-4/ });
      expect(chip.textContent).toBe('OpenRouter · claude-sonnet-4');
    });

    it('shows a provider fallback under a shared model that is the app default', async () => {
      getSessionInference.mockResolvedValue({
        success: true,
        override: null,
        resolved: {
          slot: 'peer',
          peer,
          modelId: 'qwen3-8b',
          providerDisplayName: "Bo's qwen3-8b",
          provenance: 'app-default',
          configured: true,
          needsRestart: false,
          fallbacks: [{ slot: 'openrouter' }],
        },
        marks: [{ ...sharedMark, provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4', sharedBy: undefined }],
      });
      render(<InferenceChip sessionId="s1" />);
      fireEvent.click(await screen.findByRole('button', { name: /OpenRouter · claude-sonnet-4 · fallback for Bo's qwen3-8b/ }));
      await screen.findByText('This chat tries, in order');
      expect(order()[0].textContent).toMatch(/Bo's qwen3-8b.*shared in your Circle/);
      expect(order()[1].textContent).toMatch(/OpenRouter · claude-sonnet-4/);
    });

    it('keeps a private fallback in a private project, and never names a cloud one there', async () => {
      const locked = { privacyLocked: true, slot: 'local', modelId: 'qwen3:14b', providerDisplayName: 'Local', health: 'reachable' };
      getSessionInference.mockResolvedValue(onOpenRouter([sharedMark], locked));
      const { unmount } = render(<InferenceChip sessionId="s1" />);
      await screen.findByRole('button', { name: /Bo's qwen3-8b · fallback for Local/ });
      unmount();
      getSessionInference.mockResolvedValue(
        onOpenRouter([{ ...sharedMark, provider: 'openrouter', modelId: 'x/y', sharedBy: undefined }], {
          ...locked,
          fallbacks: [{ slot: 'openrouter' }],
        })
      );
      render(<InferenceChip sessionId="s1" />);
      expect(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });

    it('ignores a mark for a model the chain no longer lists, or that is now the primary', async () => {
      getSessionInference.mockResolvedValue(onOpenRouter([sharedMark], { fallbacks: [] }));
      const { unmount } = render(<InferenceChip sessionId="s1" />);
      await screen.findByRole('button', { name: /Inference · OpenRouter · claude-sonnet-4/ });
      unmount();
      getSessionInference.mockResolvedValue(
        onOpenRouter([sharedMark], { slot: 'peer', peer, modelId: 'qwen3-8b', providerDisplayName: "Bo's qwen3-8b" })
      );
      render(<InferenceChip sessionId="s1" />);
      const chip = await screen.findByRole('button', { name: /Bo's qwen3-8b/ });
      expect(chip.textContent).toBe("Bo's qwen3-8b");
    });

    it('lets a restart say so instead of the last fallback', async () => {
      getSessionInference.mockResolvedValue(onOpenRouter([sharedMark]));
      render(<InferenceChip sessionId="s1" applying />);
      expect(await screen.findByRole('button', { name: /OpenRouter · claude-sonnet-4 · applying…/ })).toBeTruthy();
    });
  });

  it('says OpenRouter is unreachable before a send, from the slot health main pushes', async () => {
    getSessionInference.mockResolvedValue({
      success: true,
      override: null,
      resolved: {
        slot: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        providerDisplayName: 'OpenRouter',
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
      },
      marks: [],
    });
    render(<InferenceChip sessionId="s1" />);
    const chip = await screen.findByRole('button', { name: /OpenRouter · claude-sonnet-4/ });
    expect(chip.textContent).not.toContain('unreachable');
    await act(async () =>
      pushStatus.current?.({
        ...bothConfigured,
        slots: { ...bothConfigured.slots, openrouter: { ...bothConfigured.slots.openrouter, health: 'unreachable' } },
      })
    );
    expect(chip.textContent).toContain('unreachable');
    fireEvent.click(chip);
    await screen.findByText('This chat tries, in order');
    expect(order()[0].textContent).toMatch(/OpenRouter · claude-sonnet-4.*unreachable/);
    await act(async () => pushStatus.current?.(bothConfigured));
  });

  it('leaves the app default unlabelled and lists the stack it inherits', async () => {
    render(<InferenceChip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });
    expect(screen.queryByText('from app default')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    expect(order().map((row) => row.textContent)).toEqual(['1Local · qwen3:14bon this machine']);
    expect(screen.getByText('From the Chat stack')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit stack' })).toBeTruthy();
    // Only a chat with its own stack can go back to the one it inherits.
    expect(screen.queryByRole('button', { name: /^Back to/ })).toBeNull();
  });

  function resolvedLocal(provenance: string, fallbacks: Array<{ slot: string }>) {
    return {
      success: true,
      override: provenance === 'chat-override' ? { provider: 'local', modelId: 'qwen3:14b', fallbacks } : null,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance,
        configured: true,
        health: 'reachable',
        needsRestart: false,
        fallbacks,
      },
      marks: [],
    };
  }

  it("lists the supplying level's fallbacks in order, and says where the stack comes from", async () => {
    getSessionInference.mockResolvedValue(resolvedLocal('project-default', [{ slot: 'openrouter' }]));
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    expect(order().map((row) => row.textContent)).toEqual([
      '1Local · qwen3:14bon this machine',
      '2OpenRouter · claude-sonnet-4cloud · sees what the agent reads',
    ]);
    expect(screen.getByText('From this project’s stack')).toBeTruthy();
  });

  it('says a fallback that is no longer connected is skipped', async () => {
    getStatus.mockResolvedValue({
      ...bothConfigured,
      slots: { ...bothConfigured.slots, openrouter: { configured: false } },
    });
    getSessionInference.mockResolvedValue(resolvedLocal('chat-override', [{ slot: 'openrouter' }]));
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    await waitFor(() => expect(order()[1].textContent).toMatch(/OpenRouter.*not connected, skipped/));
    expect(screen.getByText('This chat’s own stack')).toBeTruthy();
  });

  it("Edit stack saves this chat's own stack with the current model first (ADR 0033 §1)", async () => {
    getSessionInference.mockResolvedValue(resolvedLocal('app-default', []));
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stack for this chat' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add model' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(setSessionInference).toHaveBeenCalledWith({
        sessionId: 's1',
        provider: 'local',
        modelId: 'qwen3:14b',
        fallbacks: [{ slot: 'openrouter' }],
      });
    });
    expect(await within(sheet).findByText('Saved. It applies to your next message.')).toBeTruthy();

    // Moving the cloud up makes it first: the chat switches provider and keeps Local after it.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move OpenRouter · claude-sonnet-4 up' }));
    await waitFor(() => {
      expect(setSessionInference).toHaveBeenLastCalledWith({
        sessionId: 's1',
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        fallbacks: [{ slot: 'local', modelId: 'qwen3:14b' }],
      });
    });
  });

  it('keeps the list as it was and says why when main refuses the stack', async () => {
    getSessionInference.mockResolvedValue(resolvedLocal('chat-override', [{ slot: 'openrouter' }]));
    setSessionInference.mockResolvedValue({ success: false, override: null, resolved: null, marks: [], error: 'That provider is not connected.' });
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stack for this chat' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Local · qwen3:14b down' }));
    expect(await within(sheet).findByText('That provider is not connected.')).toBeTruthy();
    const rungs = within(within(sheet).getByRole('list', { name: 'Model stack, first to last' })).getAllByRole('listitem');
    expect(rungs[0].textContent).toMatch(/Local · qwen3:14b/);
  });

  it('lets a shared model follow a provider in the chat’s stack, but not come first', async () => {
    const peer = { circleId: 'c1', providerId: 'p1' };
    getSessionInference.mockResolvedValue({
      ...resolvedLocal('app-default', []),
      resolved: {
        slot: 'peer',
        peer,
        modelId: 'qwen3-8b',
        providerDisplayName: "Bo's qwen3-8b",
        provenance: 'app-default',
        configured: true,
        needsRestart: false,
        fallbacks: [{ slot: 'local' }],
      },
    });
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Bo's qwen3-8b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit stack' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stack for this chat' });
    expect(within(sheet).getByText(/A shared model can follow Local or OpenRouter here, but can’t come first/)).toBeTruthy();
    expect((within(sheet).getByRole('button', { name: /^Move .*qwen3-8b up$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Move Local · qwen3:14b up' }));
    await waitFor(() => {
      expect(setSessionInference).toHaveBeenCalledWith({
        sessionId: 's1',
        provider: 'local',
        modelId: 'qwen3:14b',
        fallbacks: [{ slot: 'peer', modelId: 'qwen3-8b', peer }],
      });
    });
  });

  it('goes back to the Chat stack from a chat with its own', async () => {
    getSessionInference.mockResolvedValue(resolvedLocal('chat-override', []));
    render(<InferenceChip sessionId="s1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Chat stack' }));
    await waitFor(() => {
      expect(clearSessionInference).toHaveBeenCalledWith({ sessionId: 's1' });
    });
  });

  it('names the project’s stack as the one to go back to in a pinned project', async () => {
    getSessionInference.mockResolvedValue(resolvedLocal('chat-override', []));
    render(<InferenceChip sessionId="s1" projectInferenceKey="p1:local:qwen3:14b:false" />);
    fireEvent.click(await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    expect(screen.getByRole('button', { name: 'Back to project stack' })).toBeTruthy();
  });

  it('shows from project default provenance', async () => {
    getSessionInference.mockResolvedValue({
      success: true,
      override: null,
      resolved: {
        slot: 'local',
        modelId: 'qwen3:14b',
        providerDisplayName: 'Local',
        provenance: 'project-default',
        configured: true,
        health: 'reachable',
        needsRestart: false,
      },
      marks: [],
    });
    render(<InferenceChip sessionId="s1" projectInferenceKey="p1:local:qwen3:14b" />);
    await waitFor(() => {
      expect(screen.getByText('from project default')).toBeTruthy();
    });
  });

  it('with no session yet, shows what main resolves for a new chat, project pin included', async () => {
    getSessionInference.mockResolvedValue({
      success: false,
      override: null,
      resolved: {
        slot: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
        providerDisplayName: 'OpenRouter',
        provenance: 'project-default',
        configured: true,
        needsRestart: false,
      },
      marks: [],
      error: 'Missing session.',
    });
    const onResolvedChange = vi.fn();
    render(<InferenceChip sessionId={null} onResolvedChange={onResolvedChange} />);
    expect(await screen.findByRole('button', { name: /Inference · OpenRouter · claude-sonnet-4/ })).toBeTruthy();
    expect(getSessionInference).toHaveBeenCalledWith({ sessionId: '' });
    expect(onResolvedChange).toHaveBeenLastCalledWith(expect.objectContaining({ slot: 'openrouter' }));
    expect(probeSlotHealth).not.toHaveBeenCalled();
  });

  it('drops a slow answer for the chat it has left', async () => {
    let answerS1!: (value: unknown) => void;
    getSessionInference.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === 's1'
        ? new Promise((resolve) => (answerS1 = resolve))
        : Promise.resolve({
            success: true,
            override: null,
            resolved: {
              slot: 'openrouter',
              modelId: 'anthropic/claude-sonnet-4',
              providerDisplayName: 'OpenRouter',
              provenance: 'chat-override',
              configured: true,
              needsRestart: false,
            },
            marks: [],
          })
    );
    const { rerender } = render(<InferenceChip sessionId="s1" />);
    rerender(<InferenceChip sessionId="s2" />);
    await screen.findByRole('button', { name: /Inference · OpenRouter/ });
    await act(async () =>
      answerS1({
        success: true,
        override: null,
        resolved: {
          slot: 'local',
          modelId: 'qwen3:14b',
          providerDisplayName: 'Local',
          provenance: 'app-default',
          configured: true,
          health: 'unreachable',
          needsRestart: false,
        },
        marks: [],
      })
    );
    expect(screen.getByRole('button', { name: /Inference · OpenRouter/ })).toBeTruthy();
  });

  it('falls back to no provider when main does not answer', async () => {
    getSessionInference.mockRejectedValue(new Error('ipc closed'));
    const onResolvedChange = vi.fn();
    render(<InferenceChip sessionId="s1" onResolvedChange={onResolvedChange} />);
    await waitFor(() => expect(onResolvedChange).toHaveBeenCalledWith(null));
    expect(screen.getByRole('button', { name: /Inference · No provider/ })).toBeTruthy();
  });

  it('takes the probed health without asking main again, and re-resolves on refreshKey', async () => {
    probeSlotHealth.mockResolvedValue({ success: false, health: 'unreachable' });
    const onResolvedChange = vi.fn();
    const { rerender } = render(<InferenceChip sessionId="s1" refreshKey={0} onResolvedChange={onResolvedChange} />);
    await waitFor(() =>
      expect(onResolvedChange).toHaveBeenLastCalledWith(expect.objectContaining({ health: 'unreachable' }))
    );
    expect(getSessionInference).toHaveBeenCalledTimes(1);
    rerender(<InferenceChip sessionId="s1" refreshKey={1} onResolvedChange={onResolvedChange} />);
    await waitFor(() => expect(getSessionInference).toHaveBeenCalledTimes(2));
  });

  it('takes the local health main pushes, so a chat on Local learns it went unreachable', async () => {
    const onResolvedChange = vi.fn();
    render(<InferenceChip sessionId="s1" onResolvedChange={onResolvedChange} />);
    await waitFor(() =>
      expect(onResolvedChange).toHaveBeenLastCalledWith(expect.objectContaining({ health: 'reachable' }))
    );

    await act(async () =>
      pushStatus.current?.({
        ...bothConfigured,
        slots: { ...bothConfigured.slots, local: { ...bothConfigured.slots.local, health: 'unreachable' } },
      })
    );
    expect(onResolvedChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ slot: 'local', health: 'unreachable' })
    );
    expect(getSessionInference).toHaveBeenCalledTimes(1);
  });
});
