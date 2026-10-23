import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingProvider } from '../../onboarding/OnboardingContext';
import { SetupProvider } from '../SetupContext';
import { SetupFlowShell } from '../SetupFlowShell';

vi.mock('../../../shared/assistantStackRequirements', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/assistantStackRequirements')>();
  return {
    ...actual,
    ASSISTANT_STACK_ALREADY_RUNNING_ADVANCE_MS: 20,
  };
});

const onboardingApi = {
  getStatus: vi.fn(),
  listProviders: vi.fn(),
  discoverProviderEndpoints: vi.fn(),
  listProviderDeployments: vi.fn(),
  listDeployableModels: vi.fn(),
  adoptProviderEndpoint: vi.fn(),
  startProviderSetup: vi.fn(),
  saveOpenAiConfig: vi.fn(),
  clearOpenAiConfig: vi.fn(),
  clearPendingProviderSetup: vi.fn(),
  getProviderFormDraft: vi.fn().mockResolvedValue({ success: true, draft: null }),
  saveProviderFormDraft: vi.fn().mockResolvedValue({ success: true }),
  clearProviderFormDraft: vi.fn().mockResolvedValue({ success: true }),
  discoverLocalLlms: vi.fn().mockResolvedValue({ success: true, endpoints: [] }),
  adoptLocalLlm: vi.fn(),
  dismissLocalLlm: vi.fn().mockResolvedValue({ success: true }),
  listOAuthProviders: vi.fn().mockResolvedValue({ success: true, providers: [] }),
  startOAuthPkce: vi.fn(),
  cancelOAuthPkce: vi.fn().mockResolvedValue({ success: true }),
  listEndpointModels: vi.fn(),
  listConfiguredEndpointModels: vi.fn(),
  saveLlmConnection: vi.fn(),
  updateLlmModel: vi.fn(),
  sendLlmTestMessage: vi.fn(),
  onLocalLlmChanged: vi.fn(() => () => undefined),
};

const capabilityApi = {
  assess: vi.fn(),
  getStatus: vi.fn(),
  acknowledge: vi.fn(),
  getRuntimeDiagnostics: vi.fn(),
  getDebugLog: vi.fn().mockResolvedValue({
    path: '/tmp/boundary-debug.log',
    contents: '',
  }),
  onProgress: vi.fn(() => () => undefined),
};

const assistantStackApi = {
  getStatus: vi.fn().mockResolvedValue({
    projectName: 'boundary-assistant',
    assistantRoot: '/tmp/assistant',
    dataDir: '/tmp/data',
    overlayPath: '/tmp/overlay.yml',
    ports: {
      gateway: 8642,
      apiServer: 8643,
      dashboard: 9119,
      webui: 8787,
      searxng: 8080,
    },
    isolationMode: 'default-ports',
    apiBaseUrl: 'http://127.0.0.1:8643/v1',
    healthUrl: 'http://127.0.0.1:8643/health',
    setupComplete: false,
    ready: false,
  }),
  getLifecycle: vi.fn().mockResolvedValue({
    phase: 'idle',
    services: [],
  }),
  ensureRunning: vi.fn(),
  ensureRunningInBackground: vi.fn().mockResolvedValue({ started: true }),
  ensureAndApplyLlm: vi.fn(),
  applyLlm: vi.fn(),
  stop: vi.fn(),
  onProgress: vi.fn(() => () => undefined),
  onLifecycle: vi.fn(() => () => undefined),
};

const passAssessment = {
  passed: true,
  stackAlreadyRunning: false,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: [
    {
      id: 'runtime',
      label: 'Container runtime',
      passed: true,
      required: 'Running',
      actual: 'Running',
      detail: 'Using Boundary’s bundled container engine (Podman).',
    },
    {
      id: 'memory',
      label: 'System memory',
      passed: true,
      required: '≥ 16 GB',
      actual: '16 GB',
    },
  ],
};

const failAssessment = {
  passed: false,
  stackAlreadyRunning: false,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: [
    {
      id: 'runtime',
      label: 'Container runtime',
      passed: false,
      required: 'Running',
      actual: 'Not running',
      detail: 'Start Docker Desktop or the Docker Engine, then retry.',
    },
  ],
};

const alreadyRunningAssessment = {
  passed: true,
  stackAlreadyRunning: true,
  checkedAt: '2026-08-12T00:00:00.000Z',
  checks: passAssessment.checks,
};

function renderSetup() {
  return render(
    <OnboardingProvider>
      <SetupProvider>
        <SetupFlowShell />
      </SetupProvider>
    </OnboardingProvider>
  );
}

describe('CapabilityStep via SetupFlowShell', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'electronAPI', {
      value: {
        onboarding: onboardingApi,
        capability: capabilityApi,
        assistantStack: assistantStackApi,
      },
      writable: true,
    });
    onboardingApi.getStatus.mockResolvedValue({
      configured: false,
      encryptionAvailable: true,
    });
    onboardingApi.listProviders.mockResolvedValue([]);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: null,
    });
  });

  it('shows Continue after a passing assessment', async () => {
    capabilityApi.assess.mockResolvedValue(passAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: passAssessment,
      provisionProgress: 'Provisioned Boundary container engine.',
    });

    renderSetup();

    expect(await screen.findByText('Continue')).toBeTruthy();
    expect(screen.getByText('Container runtime')).toBeTruthy();
    expect(
      screen.getByText('Using Boundary’s bundled container engine (Podman).')
    ).toBeTruthy();
    expect(screen.getByText('Provisioned Boundary container engine.')).toBeTruthy();
    expect(screen.queryByText(/detected\. You can use/)).toBeNull();
  });

  it('shows a local LLM banner on a passing assessment without changing pass/fail', async () => {
    onboardingApi.discoverLocalLlms.mockResolvedValue({
      success: true,
      endpoints: [
        {
          runtime: 'ollama',
          displayName: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'llama3:latest', loaded: true }],
        },
      ],
    });
    capabilityApi.assess.mockResolvedValue(passAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: passAssessment,
    });

    renderSetup();

    expect(await screen.findByText('Continue')).toBeTruthy();
    expect(
      screen.getByText(
        'Ollama detected. You can use it as your model on the next step.'
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Sorry, this machine/)).toBeNull();
  });

  it('does not show the local LLM banner when assessment fails', async () => {
    onboardingApi.discoverLocalLlms.mockResolvedValue({
      success: true,
      endpoints: [
        {
          runtime: 'ollama',
          displayName: 'Ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          models: [{ id: 'llama3:latest', loaded: true }],
        },
      ],
    });
    capabilityApi.assess.mockResolvedValue(failAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: failAssessment,
    });

    renderSetup();

    expect(await screen.findByText(/below the recommended specs/)).toBeTruthy();
    expect(screen.queryByText(/detected\. You can use/)).toBeNull();
    expect(screen.getByText('Continue anyway')).toBeTruthy();
  });

  it('shows warnings and Continue anyway when assessment fails', async () => {
    capabilityApi.assess.mockResolvedValue(failAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: failAssessment,
    });

    renderSetup();

    expect(await screen.findByText(/below the recommended specs/)).toBeTruthy();
    expect(screen.getByText('Not running')).toBeTruthy();
    expect(screen.getByText('Check again')).toBeTruthy();
    expect(screen.getByText('Continue anyway')).toBeTruthy();
  });

  it('advances to LLM onboarding after Continue', async () => {
    capabilityApi.assess.mockResolvedValue(passAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: passAssessment,
    });
    capabilityApi.acknowledge.mockImplementation(async () => ({
      success: true,
      status: {
        acknowledged: true,
        lastAssessment: passAssessment,
      },
    }));

    renderSetup();

    fireEvent.click(await screen.findByText('Continue'));

    await waitFor(() => {
      expect(screen.getByText('Choose a model')).toBeTruthy();
      expect(screen.getByText('I already have a URL / API key')).toBeTruthy();
    });
  });

  it('skips capability when already acknowledged and still passing', async () => {
    capabilityApi.assess.mockResolvedValue(passAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: true,
      lastAssessment: passAssessment,
    });

    renderSetup();

    expect(await screen.findByText('Choose a model')).toBeTruthy();
    expect(screen.getByText('I already have a URL / API key')).toBeTruthy();
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('shows a green checkmark and auto-advances when the stack is already running', async () => {
    capabilityApi.assess.mockResolvedValue(alreadyRunningAssessment);
    capabilityApi.getStatus.mockResolvedValue({
      acknowledged: false,
      lastAssessment: alreadyRunningAssessment,
    });
    capabilityApi.acknowledge.mockImplementation(async () => ({
      success: true,
      status: {
        acknowledged: true,
        lastAssessment: alreadyRunningAssessment,
      },
    }));

    renderSetup();

    expect(await screen.findByLabelText('Assistant stack is running')).toBeTruthy();
    expect(screen.getByText('Your assistant is already running')).toBeTruthy();
    expect(screen.queryByText('Continue')).toBeNull();

    await waitFor(() => {
      expect(capabilityApi.acknowledge).toHaveBeenCalled();
      expect(screen.getByText('Choose a model')).toBeTruthy();
      expect(screen.getByText('I already have a URL / API key')).toBeTruthy();
    });
  });
});
