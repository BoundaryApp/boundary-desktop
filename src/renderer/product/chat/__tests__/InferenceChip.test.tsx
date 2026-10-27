import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('InferenceChip', () => {
  afterEach(() => {
    cleanup();
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

  it('leaves the app default unlabelled and lists both providers', async () => {
    render(<InferenceChip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });
    expect(screen.queryByText('from app default')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    expect(screen.getByRole('option', { name: /OpenRouter · claude-sonnet-4/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use project default' })).toBeTruthy();
  });

  it('writes an override when the other provider is chosen', async () => {
    render(<InferenceChip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    fireEvent.click(screen.getByRole('option', { name: /OpenRouter · claude-sonnet-4/ }));
    await waitFor(() => {
      expect(setSessionInference).toHaveBeenCalledWith({
        sessionId: 's1',
        provider: 'openrouter',
        modelId: 'anthropic/claude-sonnet-4',
      });
    });
  });

  it('clears the override from Use project default', async () => {
    render(<InferenceChip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use project default' }));
    await waitFor(() => {
      expect(clearSessionInference).toHaveBeenCalledWith({ sessionId: 's1' });
    });
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

  it('says a cloud slot sees what the agent reads, not that it runs on this machine', async () => {
    render(<InferenceChip sessionId="s1" />);
    const chip = await screen.findByRole('button', { name: /Inference · Local · qwen3:14b/ });
    fireEvent.click(chip);
    expect(screen.getByText('cloud · sees what the agent reads')).toBeTruthy();
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
