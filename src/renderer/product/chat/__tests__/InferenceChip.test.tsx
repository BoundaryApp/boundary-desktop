import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InferenceChip } from '../InferenceChip';

const getStatus = vi.fn();
const probeSlotHealth = vi.fn();
const getSessionInference = vi.fn();
const setSessionInference = vi.fn();
const clearSessionInference = vi.fn();

vi.mock('../../../services/onboardingIPCService', () => ({
  onboardingIPC: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    probeSlotHealth: (...args: unknown[]) => probeSlotHealth(...args),
  },
}));

vi.mock('../../../services/hermesChatIPCService', () => ({
  hermesChatIPC: {
    getSessionInference: (...args: unknown[]) => getSessionInference(...args),
    setSessionInference: (...args: unknown[]) => setSessionInference(...args),
    clearSessionInference: (...args: unknown[]) => clearSessionInference(...args),
  },
}));

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

  it('shows app-default provenance and lists both providers', async () => {
    render(<InferenceChip sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Inference · Local · qwen3:14b/ })).toBeTruthy();
    });
    expect(screen.getByText('from app default')).toBeTruthy();
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
});
