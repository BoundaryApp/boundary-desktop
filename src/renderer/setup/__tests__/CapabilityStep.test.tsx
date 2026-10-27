import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { SetupProvider, useSetup } from '../SetupContext';
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
  discoverLocalLlms: vi.fn().mockResolvedValue({ success: true, endpoints: [] }),
  adoptLocalLlm: vi.fn(),
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
    <SetupProvider>
      <SetupFlowShell />
    </SetupProvider>
  );
}

describe('CapabilityStep via SetupFlowShell', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronAPI({
      onboarding: onboardingApi,
      capability: capabilityApi,
      assistantStack: assistantStackApi,
      // No stored progress: the optional steps count as answered, as when the read fails.
      setup: { getProgress: vi.fn().mockRejectedValue(new Error('no progress')) },
    });
    onboardingApi.getStatus.mockResolvedValue({
      configured: false,
      encryptionAvailable: true,
    });
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

  it('does not assess on launch once the Machine step is acknowledged', async () => {
    // An assessment that never answers would hold a set-up user on "Preparing Boundary".
    capabilityApi.assess.mockReturnValue(new Promise(() => undefined));
    capabilityApi.getStatus.mockResolvedValue({ acknowledged: true, lastAssessment: null });
    onboardingApi.getStatus.mockResolvedValue({
      configured: true,
      encryptionAvailable: true,
      appDefault: 'local',
      slots: {},
    });
    assistantStackApi.getStatus.mockResolvedValueOnce({
      ...(await assistantStackApi.getStatus()),
      setupComplete: true,
      ready: true,
    });
    const Probe = () => <p>{useSetup().allComplete ? 'all complete' : 'waiting'}</p>;
    render(
      <SetupProvider>
        <Probe />
      </SetupProvider>
    );
    expect(await screen.findByText('all complete')).toBeTruthy();
    expect(capabilityApi.assess).not.toHaveBeenCalled();
  });

  it('offers Try again when reading the stored status fails, and assesses after it', async () => {
    capabilityApi.getStatus.mockRejectedValueOnce(new Error('store unreadable'));
    capabilityApi.assess.mockResolvedValue(passAssessment);
    renderSetup();
    expect(await screen.findByText('Couldn’t check this Mac')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Continue')).toBeTruthy();
    expect(capabilityApi.assess).toHaveBeenCalledTimes(1);
  });

  it('shows local LLMs the Model step finds, and ones main reports later', async () => {
    let reportChange: (payload: { endpoints: unknown[] }) => void = () => undefined;
    onboardingApi.onLocalLlmChanged.mockImplementation(((cb: typeof reportChange) => {
      reportChange = cb;
      return () => undefined;
    }) as never);
    onboardingApi.discoverLocalLlms.mockResolvedValue({ success: true, endpoints: [] });
    capabilityApi.getStatus.mockResolvedValue({ acknowledged: true, lastAssessment: passAssessment });

    renderSetup();
    expect(await screen.findByText('Choose a model')).toBeTruthy();
    expect(onboardingApi.discoverLocalLlms).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Use Ollama')).toBeNull();

    await act(async () =>
      reportChange({
        endpoints: [
          {
            runtime: 'ollama',
            displayName: 'Ollama',
            baseUrl: 'http://127.0.0.1:11434/v1',
            models: [{ id: 'llama3:latest', loaded: true }],
          },
        ],
      })
    );
    expect(screen.getByText('Use Ollama')).toBeTruthy();
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

describe('SetupProvider skipStep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    capabilityApi.getStatus.mockResolvedValue({ acknowledged: true, lastAssessment: passAssessment });
    onboardingApi.getStatus.mockResolvedValue({ configured: false, encryptionAvailable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('skips the step for this run when main cannot store the skip', async () => {
    const recordOutcome = vi.fn().mockRejectedValue(new Error('store write failed'));
    stubElectronAPI({
      onboarding: onboardingApi,
      capability: capabilityApi,
      assistantStack: assistantStackApi,
      setup: {
        getProgress: vi.fn().mockResolvedValue({
          completedBeforeOptionalSteps: false,
          hadProjectsBeforeOptionalSteps: false,
          outcomes: {},
          pendingFolders: [],
        }),
        recordOutcome,
      },
    });
    const { result } = renderHook(() => useSetup(), { wrapper: SetupProvider });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.setupProgress?.outcomes).toEqual({});

    await act(() => result.current.skipStep('folders'));
    expect(recordOutcome).toHaveBeenCalledWith({ stepId: 'folders', outcome: 'skipped' });
    expect(result.current.setupProgress?.outcomes).toEqual({ folders: 'skipped' });
  });
});
