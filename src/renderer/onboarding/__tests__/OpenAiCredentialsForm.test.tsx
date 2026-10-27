import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import type { InferenceProvidersStatus } from '../../../shared/types/onboarding';

const onboarding = vi.hoisted(() => ({
  status: null as InferenceProvidersStatus | null,
}));

vi.mock('../inferenceStatus', () => ({
  useInferenceStatus: () => onboarding,
  takeInferenceStatus: vi.fn(),
}));
stubElectronAPI({ onboarding: { listEndpointModels: vi.fn(), saveLlmConnection: vi.fn() } });

import { OpenAiCredentialsForm } from '../OpenAiCredentialsForm';

// OpenRouter is signed in and is the app default, with no model picked yet.
const openRouterDefault: InferenceProvidersStatus = {
  configured: false,
  encryptionAvailable: true,
  appDefault: 'openrouter',
  slots: {
    openrouter: {
      configured: false,
      endpointUrl: 'https://openrouter.ai/api/v1',
      provider: 'openrouter',
      authScheme: 'bearer',
      apiKey: { configured: true, preview: 'sk-or…1234' },
    },
  },
};

function endpointValue(): string {
  return (screen.getByLabelText('Endpoint URL') as HTMLInputElement).value;
}

describe('OpenAiCredentialsForm', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not prefill the local form from another slot that is the app default', () => {
    onboarding.status = openRouterDefault;
    render(<OpenAiCredentialsForm variant="local" />);

    expect(endpointValue()).toBe('http://127.0.0.1:11434/v1');
    expect(screen.queryByText(/Saved key/)).toBeNull();
  });

  it('does not prefill the custom form from another slot that is the app default', () => {
    onboarding.status = openRouterDefault;
    render(<OpenAiCredentialsForm variant="custom" />);

    expect(endpointValue()).toBe('');
    expect(screen.queryByText(/Saved key/)).toBeNull();
  });

  it('prefills the custom form from the saved custom endpoint', () => {
    onboarding.status = {
      ...openRouterDefault,
      slots: {
        ...openRouterDefault.slots,
        infrastructure: {
          configured: true,
          endpointUrl: 'https://custom.example/v1',
          modelId: 'm',
          provider: 'manual',
          apiKey: { configured: true, preview: 'sk-cu…5678' },
        },
      },
    };
    render(<OpenAiCredentialsForm variant="custom" />);

    expect(endpointValue()).toBe('https://custom.example/v1');
    expect(screen.getByText(/Saved key: sk-cu…5678/)).toBeTruthy();

    // The saved key is not reused for another URL, so the note goes away.
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'https://other.example/v1' },
    });
    expect(screen.queryByText(/Saved key/)).toBeNull();
  });

  it('prefills the local form from the local slot', () => {
    onboarding.status = {
      ...openRouterDefault,
      slots: {
        ...openRouterDefault.slots,
        local: {
          configured: true,
          endpointUrl: 'http://127.0.0.1:8080/v1',
          modelId: 'm',
          provider: 'local-manual',
          apiKey: { configured: true, preview: 'loca…' },
        },
      },
    };
    render(<OpenAiCredentialsForm variant="local" />);

    expect(endpointValue()).toBe('http://127.0.0.1:8080/v1');
  });

  it('rejects an endpoint URL that is not http or https before loading models', () => {
    onboarding.status = openRouterDefault;
    render(<OpenAiCredentialsForm variant="custom" />);

    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(screen.getByText('Enter a valid OpenAI-compatible endpoint URL.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'ftp://host/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(screen.getByText('Endpoint URL must start with http:// or https://.')).toBeTruthy();
  });

  it('shows a rejected model load or save as an error', async () => {
    onboarding.status = openRouterDefault;
    const api = window.electronAPI.onboarding;
    vi.mocked(api.listEndpointModels)
      .mockRejectedValueOnce(new Error('models request failed'))
      .mockResolvedValueOnce({ success: true, models: [{ id: 'model-a', name: 'Model A' }] });
    vi.mocked(api.saveLlmConnection).mockRejectedValueOnce(new Error('save request failed'));
    render(<OpenAiCredentialsForm variant="custom" />);
    fireEvent.change(screen.getByLabelText('Endpoint URL'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'test-key' } });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load models' })));
    expect(screen.getByText('models request failed')).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load models' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Continue' })));
    expect(screen.getByText('save request failed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
