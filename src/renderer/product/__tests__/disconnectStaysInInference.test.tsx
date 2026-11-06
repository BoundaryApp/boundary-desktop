import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { SetupProvider } from '../../setup/SetupContext';
import { ProductApp } from '../ProductApp';
import { InferenceScreen } from '../inference/InferenceScreen';

// The app as the public repository has it; each experiment tests what it adds beside its code.
vi.mock('../../experiments', () => ({ rendererExperiments: [] }));

vi.mock('../../setup/SetupFlowShell', () => ({
  SetupFlowShell: () => <div>setup-flow</div>,
}));

// The shell's job here is only to keep Inference mounted; setup gating above it is under test.
vi.mock('../ProductReadyShell', () => ({
  ProductReadyShell: () => <InferenceScreen />,
}));

const openRouterOnly = {
  configured: true,
  encryptionAvailable: true,
  appDefault: 'openrouter' as const,
  slots: {
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

const nothingConnected = {
  configured: false,
  encryptionAvailable: true,
  appDefault: null,
  slots: {},
  savedOpenRouterKey: { preview: 'sk-or-…7f2a', modelId: 'anthropic/claude-sonnet-4' },
};

function stubApp() {
  const onboarding = {
    getStatus: vi.fn().mockResolvedValue(openRouterOnly),
    describeAppStack: vi.fn().mockResolvedValue({ entries: [], noPrivate: false }),
    probeSlotHealth: vi.fn().mockResolvedValue({ success: true, health: 'reachable' }),
    listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    clearLlmSlot: vi.fn().mockResolvedValue({ success: true, status: nothingConnected }),
    reconnectSavedOpenRouterKey: vi
      .fn()
      .mockResolvedValue({ success: true, status: openRouterOnly }),
  };
  stubElectronAPI({
    onboarding,
    capability: {
      getStatus: vi.fn().mockResolvedValue({ acknowledged: true, lastAssessment: null }),
    },
    setup: {
      getProgress: vi.fn().mockResolvedValue({
        completedBeforeOptionalSteps: false,
        hadProjectsBeforeOptionalSteps: false,
        outcomes: { folders: 'done' },
        pendingFolders: [],
      }),
    },
    assistantStack: {
      getStatus: vi.fn().mockResolvedValue({ setupComplete: true, ready: true }),
      getLifecycle: vi.fn().mockResolvedValue(createLifecycleSnapshot('ready')),
    },
  });
  return onboarding;
}

describe('disconnecting the last provider', () => {
  afterEach(() => cleanup());

  it('stays on Inference, offers a first model, and reconnects with the saved key', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onboarding = stubApp();
    render(
      <SetupProvider>
        <ProductApp />
      </SetupProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText('Add your first model')).toBeTruthy();
    expect(onboarding.clearLlmSlot).toHaveBeenCalledWith({ slot: 'openrouter' });
    expect(screen.queryByText('setup-flow')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Inference' })).toBeTruthy();
    expect(screen.getByText(/sk-or-…7f2a/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    await waitFor(() => expect(screen.queryByText('Add your first model')).toBeNull());
    expect(screen.queryByText('setup-flow')).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });
});
