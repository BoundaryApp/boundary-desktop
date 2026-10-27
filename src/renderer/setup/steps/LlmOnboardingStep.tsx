import React, { useEffect, useRef, useState } from 'react';
import { OnboardingHomeScreen } from '../../onboarding/OnboardingHomeScreen';
import { OpenAiCredentialsForm } from '../../onboarding/OpenAiCredentialsForm';
import { OAuthModelPickView } from '../../onboarding/OAuthModelPickView';
import { takeInferenceStatus, useInferenceStatus } from '../../onboarding/inferenceStatus';
import type {
  DiscoveredLocalLlm,
  InferenceProvidersStatus,
  OAuthConnectionProviderId,
  OAuthConnectionProviderSummary,
  OAuthPkceCredentialsBundle,
  PendingProviderSetup,
} from '../../../shared/types/onboarding';
import { SetupShell, SetupSpinner } from '../SetupShell';
import { useSetup } from '../SetupContext';
import { Callout } from '../../components/ui/alert';
import type { SetupStepProps } from '../types';
import { useAssistantStackLifecycle } from '../../product/assistantStack';
import { rendererExperiments } from '../../experiments';

const ProviderSetupView = rendererExperiments.find((e) => e.ProviderSetupView)?.ProviderSetupView;
const homeRows = rendererExperiments.flatMap((e) => (e.HomeRow ? [e.HomeRow] : []));

type OnboardingView = 'home' | 'oauth-model' | 'existing' | 'provider-setup';

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
  const { loading, error, status } = useInferenceStatus();
  const [view, setView] = useState<OnboardingView>('home');
  const [existingVariant, setExistingVariant] = useState<ExistingVariant>('custom');
  const [pendingSetup, setPendingSetup] = useState<PendingProviderSetup | null>(null);
  const { localLlms, discoverLocalLlms } = useSetup();
  const [localLlmError, setLocalLlmError] = useState<string | null>(null);
  const [oauthProviders, setOauthProviders] = useState<OAuthConnectionProviderSummary[]>([]);
  const [oauthLoading, setOauthLoading] = useState(true);
  const [oauthConnecting, setOauthConnecting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthCredentials, setOauthCredentials] = useState<OAuthPkceCredentialsBundle | null>(null);
  const didAutoResumeOauth = useRef(false);
  const oauthCancelled = useRef(false);
  const stackLifecycle = useAssistantStackLifecycle();
  const backgroundEnsureStarted = useRef(false);

  const primaryOauthProvider = oauthProviders[0] ?? null;
  const pendingOauth = pendingOAuthCredentialsFromStatus(status);

  useEffect(() => {
    if (backgroundEnsureStarted.current) return;
    backgroundEnsureStarted.current = true;
    void window.electronAPI.assistantStack.ensureRunningInBackground().catch(() => {
      /* lifecycle carries failures */
    });
  }, []);

  const stackPreparingInBackground =
    stackLifecycle.phase === 'starting' ||
    (stackLifecycle.phase !== 'ready' &&
      stackLifecycle.phase !== 'error' &&
      Boolean(stackLifecycle.message) &&
      stackLifecycle.stage !== 'idle' &&
      stackLifecycle.stage !== undefined);

  useEffect(() => {
    if (status?.pending && ProviderSetupView) {
      setPendingSetup(status.pending);
      setView('provider-setup');
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
    const loadOauthProviders = async () => {
      setOauthLoading(true);
      try {
        const result = await window.electronAPI.onboarding.listOAuthProviders();
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

  // The Machine step's assessment discovers too, but a returning user may skip it.
  useEffect(() => {
    void discoverLocalLlms();
  }, [discoverLocalLlms]);

  const handleUseLocalLlm = async (endpoint: DiscoveredLocalLlm, modelId: string) => {
    setLocalLlmError(null);
    const result = await window.electronAPI.onboarding.adoptLocalLlm({
      runtime: endpoint.runtime,
      endpointUrl: endpoint.baseUrl,
      modelId,
    });
    if (!result.success) {
      setLocalLlmError(result.error ?? 'Unable to use this local endpoint.');
      return;
    }
    await takeInferenceStatus(result);
  };

  const handleOauthSignIn = async () => {
    if (!primaryOauthProvider) return;
    setOauthConnecting(true);
    setOauthError(null);
    setOauthCredentials(null);
    oauthCancelled.current = false;
    try {
      const result = await window.electronAPI.onboarding.startOAuthPkce({ providerId: primaryOauthProvider.id });
      if (oauthCancelled.current) return;
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

  const cancelOauthSignIn = () => {
    oauthCancelled.current = true;
    void window.electronAPI.onboarding.cancelOAuthPkce();
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

  if (view === 'provider-setup' && ProviderSetupView) {
    return <ProviderSetupView pending={pendingSetup} onHome={goHome} />;
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
        onCancelSignIn={cancelOauthSignIn}
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
        extraRows={homeRows.map((HomeRow, index) => (
          <HomeRow
            key={index}
            onSelect={() => {
              setPendingSetup(null);
              setView('provider-setup');
            }}
          />
        ))}
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
