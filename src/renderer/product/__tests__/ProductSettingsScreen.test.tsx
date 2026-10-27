import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { ProductSettingsScreen } from '../ProductSettingsScreen';

const onboardingApi = {
  getStatus: vi.fn(),
  probeSlotHealth: vi.fn(),
  listConfiguredEndpointModels: vi.fn(),
  discoverLocalLlms: vi.fn(),
  adoptLocalLlm: vi.fn(),
  startOAuthPkce: vi.fn(),
  cancelOAuthPkce: vi.fn(),
  listEndpointModels: vi.fn(),
  saveLlmConnection: vi.fn(),
  updateLlmModel: vi.fn(),
  sendLlmTestMessage: vi.fn(),
  clearLlmSlot: vi.fn(),
  setAppDefault: vi.fn(),
};

const localOnlyStatus = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: {
    local: {
      configured: true,
      endpointUrl: 'http://127.0.0.1:11434/v1',
      modelId: 'qwen3:14b',
      provider: 'ollama',
      providerDisplayName: 'Ollama',
      capabilities: {
        kind: 'local-llm' as const,
        modelChangePolicy: 'selectable' as const,
        endpointChangePolicy: 'editable' as const,
        supportsModelRefresh: true,
      },
      health: 'reachable' as const,
    },
  },
};

const bothStatus = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'local' as const,
  slots: {
    local: localOnlyStatus.slots.local,
    openrouter: {
      configured: true,
      endpointUrl: 'https://openrouter.ai/api/v1',
      modelId: 'anthropic/claude-sonnet-4',
      provider: 'openrouter',
      providerDisplayName: 'OpenRouter',
      capabilities: {
        kind: 'oauth' as const,
        modelChangePolicy: 'selectable' as const,
        endpointChangePolicy: 'fixed' as const,
        supportsModelRefresh: true,
      },
      health: 'reachable' as const,
      apiKey: { configured: true, preview: 'sk-or-…7f2a' },
    },
  },
};

describe('ProductSettingsScreen', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    stubElectronAPI({ onboarding: onboardingApi });
    onboardingApi.probeSlotHealth.mockImplementation(async () => ({
      success: true,
      health: 'reachable',
      status: await onboardingApi.getStatus(),
    }));
    onboardingApi.listConfiguredEndpointModels.mockResolvedValue({ success: true, models: [] });
  });

  it('shows empty cards and a disabled no-default radio', async () => {
    onboardingApi.getStatus.mockResolvedValue({
      configured: false,
      encryptionAvailable: true,
      appDefault: null,
      slots: {},
    });

    render(<ProductSettingsScreen onBack={() => undefined} />);

    expect(await screen.findByText('Inference')).toBeTruthy();
    expect(screen.getByText('Scan this machine')).toBeTruthy();
    expect(screen.getByText('Connect OpenRouter')).toBeTruthy();
    expect(screen.getByRole('button', { name: /No default yet/i })).toHaveProperty('disabled', true);
  });

  it('cancels a pending OpenRouter sign-in without showing an error', async () => {
    onboardingApi.getStatus.mockResolvedValue(localOnlyStatus);
    let finishSignIn: (result: { success: boolean; error?: string }) => void = () => undefined;
    onboardingApi.startOAuthPkce.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSignIn = resolve;
        })
    );
    onboardingApi.cancelOAuthPkce.mockImplementation(async () => {
      finishSignIn({ success: false, error: 'OAuth authorization was cancelled.' });
      return { success: true };
    });

    render(<ProductSettingsScreen onBack={() => undefined} />);

    fireEvent.click(await screen.findByText('Connect OpenRouter'));
    expect(await screen.findByText(/Waiting for OpenRouter sign-in/)).toBeTruthy();
    expect(screen.getByText('Connect OpenRouter').closest('button')).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onboardingApi.cancelOAuthPkce).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText(/Waiting for OpenRouter sign-in/)).toBeNull());
    expect(screen.getByText('Connect OpenRouter').closest('button')).toHaveProperty('disabled', false);
    expect(screen.queryByText(/cancelled/)).toBeNull();
    expect(onboardingApi.listEndpointModels).not.toHaveBeenCalled();
  });

  it('shows a live local card and keeps the OpenRouter radio disabled', async () => {
    onboardingApi.getStatus.mockResolvedValue(localOnlyStatus);

    render(<ProductSettingsScreen onBack={() => undefined} />);

    expect(await screen.findByText('Ollama')).toBeTruthy();
    expect(screen.getByText('Connect OpenRouter')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Local · qwen3:14b/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cloud is the machine default/i })).toHaveProperty(
      'disabled',
      true
    );
  });

  it('lets the user choose the other configured provider as app default', async () => {
    onboardingApi.getStatus.mockResolvedValue(bothStatus);
    onboardingApi.setAppDefault.mockResolvedValue({
      success: true,
      status: { ...bothStatus, appDefault: 'openrouter' },
    });

    render(<ProductSettingsScreen onBack={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: /OpenRouter · anthropic\/claude-sonnet-4/i }));

    await waitFor(() => {
      expect(onboardingApi.setAppDefault).toHaveBeenCalledWith({ slot: 'openrouter' });
    });
  });

  it('disconnects local and falls back to the remaining provider', async () => {
    onboardingApi.getStatus.mockResolvedValue(bothStatus);
    onboardingApi.clearLlmSlot.mockResolvedValue({
      success: true,
      status: {
        configured: true,
        encryptionAvailable: true,
        appDefault: 'openrouter',
        slots: { openrouter: bothStatus.slots.openrouter },
      },
    });

    render(<ProductSettingsScreen onBack={() => undefined} />);

    const disconnectButtons = await screen.findAllByRole('button', { name: 'Disconnect' });
    fireEvent.click(disconnectButtons[0]);

    await waitFor(() => {
      expect(onboardingApi.clearLlmSlot).toHaveBeenCalledWith({ slot: 'local' });
    });
  });
});
