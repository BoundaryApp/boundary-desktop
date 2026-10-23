import React, { useEffect, useRef, useState } from 'react';
import { OnboardingHomeScreen } from '../../onboarding/OnboardingHomeScreen';
import { OpenAiCredentialsForm } from '../../onboarding/OpenAiCredentialsForm';
import { OAuthModelPickView } from '../../onboarding/OAuthModelPickView';
import { ProviderGrid } from '../../onboarding/ProviderGrid';
import { ProviderConfigForm } from '../../onboarding/ProviderConfigForm';
import { ProviderProvisioningProgress } from '../../onboarding/ProviderProvisioningProgress';
import { useOnboarding } from '../../onboarding/OnboardingContext';
import { onboardingIPC } from '../../services/onboardingIPCService';
import { assistantStackIPC } from '../../services/assistantStackIPCService';
import type {
  DiscoveredLocalLlm,
  InferenceProvidersStatus,
  OAuthConnectionProviderId,
  OAuthConnectionProviderSummary,
  OAuthPkceCredentialsBundle,
  OnboardingProviderConfig,
  PendingProviderSetup,
} from '../../../shared/types/onboarding';
import { SetupShell, SetupSpinner } from '../SetupShell';
import { Callout } from '../../components/ui/alert';
import type { SetupStepProps } from '../types';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleSnapshot } from '../../../shared/types/assistantStack';

type OnboardingView =
  | 'home'
  | 'oauth-model'
  | 'existing'
  | 'providers'
  | 'provider-config'
  | 'provider-progress';

type ExistingVariant = 'custom' | 'local';

function pendingOAuthCredentialsFromStatus(
  status: InferenceProvidersStatus | null
): OAuthPkceCredentialsBundle | null {
  const slot = status?.slots?.openrouter;
  if (
    !slot ||
    slot.configured ||
    !slot.endpointUrl ||
    !slot.provider ||
    !slot.apiKey?.configured ||
    slot.capabilities?.kind !== 'oauth' ||
    !slot.capabilities
  ) {
    return null;
  }

  return {
    providerId: slot.provider as OAuthConnectionProviderId,
    providerDisplayName: slot.providerDisplayName ?? slot.provider,
    endpointUrl: slot.endpointUrl,
    authScheme: slot.authScheme ?? 'bearer',
    capabilities: slot.capabilities,
  };
}

export const LlmOnboardingStep: React.FC<Partial<SetupStepProps>> = ({
  title = 'Choose a model',
  description = 'Pick where replies come from. You can add or switch models later in Settings.',
}) => {
  const { loading, error, status, refresh } = useOnboarding();
  const [view, setView] = useState<OnboardingView>('home');
  const [existingVariant, setExistingVariant] = useState<ExistingVariant>('custom');
  const [providers, setProviders] = useState<OnboardingProviderConfig[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<OnboardingProviderConfig | null>(null);
  const [pendingSetup, setPendingSetup] = useState<PendingProviderSetup | null>(null);
  const [localLlms, setLocalLlms] = useState<DiscoveredLocalLlm[]>([]);
  const [localLlmError, setLocalLlmError] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthConnectionProviderSummary[]>([]);
  const [oauthLoading, setOauthLoading] = useState(true);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthCredentials, setOauthCredentials] = useState<OAuthPkceCredentialsBundle | null>(null);
  const didAutoResumeOauth = useRef(false);
  const [stackLifecycle, setStackLifecycle] = useState<AssistantStackLifecycleSnapshot>(() =>
    createLifecycleSnapshot('idle')
  );
  const backgroundEnsureStarted = useRef(false);

  const primaryOauthProvider = oauthProviders[0] ?? null;
  const pendingOauth = pendingOAuthCredentialsFromStatus(status);

  useEffect(() => {
    if (backgroundEnsureStarted.current) return;
    backgroundEnsureStarted.current = true;
    void assistantStackIPC.ensureRunningInBackground().catch(() => {
      /* lifecycle carries failures */
    });
  }, []);

  useEffect(() => {
    void assistantStackIPC.getLifecycle().then(setStackLifecycle);
    return assistantStackIPC.onLifecycle(setStackLifecycle);
  }, []);

  const stackPreparingInBackground =
    stackLifecycle.phase === 'starting' ||
    (stackLifecycle.phase !== 'ready' &&
      stackLifecycle.phase !== 'error' &&
      Boolean(stackLifecycle.message) &&
      stackLifecycle.stage !== 'idle' &&
      stackLifecycle.stage !== undefined);

  useEffect(() => {
    if (status?.pending) {
      setPendingSetup(status.pending);
      setView('provider-progress');
      return;
    }

    if (didAutoResumeOauth.current) return;
    if (!pendingOauth) return;
    didAutoResumeOauth.current = true;
    setOauthCredentials(pendingOauth);
    setView('oauth-model');
  }, [pendingOauth, status?.pending]);

  const continuePendingOauth = () => {
    if (!pendingOauth) return;
    setOauthError(null);
    setOauthCredentials(pendingOauth);
    setView('oauth-model');
  };

  useEffect(() => {
    let cancelled = false;
    const loadProviders = async () => {
      setProvidersLoading(true);
      setProvidersError(null);
      try {
        const result = await onboardingIPC.listProviders();
        if (!cancelled) setProviders(result);
      } catch (e) {
        if (!cancelled) setProvidersError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setProvidersLoading(false);
      }
    };
    void loadProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadOauthProviders = async () => {
      setOauthLoading(true);
      try {
        const result = await onboardingIPC.listOAuthProviders();
        if (!cancelled) {
          if (result.success) {
            setOauthProviders(result.providers);
            setOauthError(null);
          } else {
            setOauthError(result.error ?? 'Unable to load OAuth providers.');
          }
        }
      } finally {
        if (!cancelled) setOauthLoading(false);
      }
    };
    void loadOauthProviders();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadLocalLlms = async () => {
      try {
        const result = await onboardingIPC.discoverLocalLlms();
        if (!cancelled && result.success) {
          setLocalLlms(result.endpoints);
        }
      } catch {
        // Optional; the watcher will retry.
      }
    };
    void loadLocalLlms();
    const unsubscribe = onboardingIPC.onLocalLlmChanged((payload) => {
      setLocalLlms(payload.endpoints);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const handleUseLocalLlm = async (endpoint: DiscoveredLocalLlm, modelId: string) => {
    setLocalLlmError(null);
    const result = await onboardingIPC.adoptLocalLlm({
      runtime: endpoint.runtime,
      endpointUrl: endpoint.baseUrl,
      modelId,
    });
    if (!result.success) {
      setLocalLlmError(result.error ?? 'Unable to use this local endpoint.');
      return;
    }
    await refresh();
  };

  const handleOauthSignIn = async () => {
    if (!primaryOauthProvider) return;
    setOauthConnecting(true);
    setOauthError(null);
    setOauthCredentials(null);
    try {
      const result = await onboardingIPC.startOAuthPkce({ providerId: primaryOauthProvider.id });
      if (!result.success || !result.credentials) {
        setOauthError(result.error ?? 'OAuth sign-in failed.');
        return;
      }
      setOauthCredentials(result.credentials);
      setView('oauth-model');
    } finally {
      setOauthConnecting(false);
    }
  };

  const goHome = () => {
    setView('home');
    setOauthCredentials(null);
    setOauthError(null);
  };

  if (loading) {
    return (
      <SetupShell title={title} description={description} centered>
        <SetupSpinner label="Checking for a saved model connection…" />
      </SetupShell>
    );
  }

  if (view === 'oauth-model' && oauthCredentials) {
    return (
      <SetupShell
        title={`Choose a ${oauthCredentials.providerDisplayName} model`}
        description="Pick the model Boundary uses by default. You can change it per chat or project later."
        onBack={goHome}
        width="wide"
      >
        <OAuthModelPickView credentials={oauthCredentials} />
      </SetupShell>
    );
  }

  if (view === 'existing') {
    return (
      <SetupShell
        title={existingVariant === 'local' ? 'Connect a local server' : 'Use your own endpoint'}
        description={
          existingVariant === 'local'
            ? 'Enter the OpenAI-compatible URL for Ollama, LM Studio, or another server on this machine.'
            : 'Enter an OpenAI-compatible URL and API key. Boundary lists its models next.'
        }
        onBack={goHome}
        width="wide"
      >
        <OpenAiCredentialsForm key={existingVariant} variant={existingVariant} />
      </SetupShell>
    );
  }

  if (view === 'providers') {
    return (
      <SetupShell
        title="Deploy my own GPUs"
        description="Choose a provider to host an OpenAI-compatible endpoint for you."
        onBack={goHome}
        width="wide"
      >
        {providersError && <Callout variant="destructive">{providersError}</Callout>}
        {providersLoading ? (
          <SetupSpinner label="Loading providers…" />
        ) : (
          <ProviderGrid
            providers={providers}
            onSelect={(provider) => {
              setSelectedProvider(provider);
              setView('provider-config');
            }}
          />
        )}
      </SetupShell>
    );
  }

  if (view === 'provider-config' && selectedProvider) {
    return (
      <SetupShell
        title={`Deploy on ${selectedProvider.name}`}
        description="Connect your provider account, reuse an existing endpoint, or deploy a catalog model."
        onBack={() => setView('providers')}
        width="wide"
      >
        <ProviderConfigForm
          key={selectedProvider.id}
          provider={selectedProvider}
          onStarted={(pending) => {
            setPendingSetup(pending);
            setView('provider-progress');
          }}
        />
      </SetupShell>
    );
  }

  if (view === 'provider-progress' && pendingSetup) {
    return (
      <SetupShell
        title="Creating your endpoint"
        description="Boundary is starting the provider instance and will confirm a real reply before it finishes."
      >
        <ProviderProvisioningProgress
          pending={pendingSetup}
          onRetry={async () => {
            const retryProviderId = pendingSetup.providerId;
            await onboardingIPC.clearPendingProviderSetup();
            await refresh();
            setPendingSetup(null);
            const provider =
              providers.find((item) => item.id === retryProviderId) ??
              (await onboardingIPC.listProviders()).find((item) => item.id === retryProviderId) ??
              null;
            if (provider) {
              setSelectedProvider(provider);
              setView('provider-config');
              return;
            }
            setView('providers');
          }}
        />
      </SetupShell>
    );
  }

  return (
    <SetupShell title={title} description={description}>
      {error && <Callout variant="destructive">{error}</Callout>}
      {localLlmError && <Callout variant="destructive">{localLlmError}</Callout>}
      <OnboardingHomeScreen
        oauthProvider={primaryOauthProvider}
        oauthLoading={oauthLoading}
        oauthConnecting={oauthConnecting}
        oauthError={oauthError}
        oauthPendingContinue={
          pendingOauth
            ? { displayName: pendingOauth.providerDisplayName }
            : null
        }
        onSignIn={() => void handleOauthSignIn()}
        onContinuePendingOauth={continuePendingOauth}
        localEndpoints={localLlms}
        onUseLocalEndpoint={handleUseLocalLlm}
        onUseExisting={() => {
          setExistingVariant('custom');
          setView('existing');
        }}
        onConnectLocalManual={() => {
          setExistingVariant('local');
          setView('existing');
        }}
      />
      {stackPreparingInBackground && (
        <p className="flex items-center gap-2 text-xs text-fg-faint" role="status">
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-brand" />
          {stackLifecycle.message ?? 'Preparing assistant services in the background…'}
        </p>
      )}
    </SetupShell>
  );
};
