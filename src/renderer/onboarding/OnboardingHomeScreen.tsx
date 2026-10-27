import React from 'react';
import type {
  DiscoveredLocalLlm,
  OAuthConnectionProviderSummary,
} from '../../shared/types/onboarding';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Pill } from '../components/ui/badge';
import { ChoiceRow } from './ChoiceRow';
import { LocalLlmDiscoveryCards } from './LocalLlmDiscoveryCards';
import { cloudInferenceNotice } from '../product/cloudInferenceCopy';

interface OnboardingHomeScreenProps {
  oauthProvider: OAuthConnectionProviderSummary | null;
  oauthLoading: boolean;
  oauthConnecting: boolean;
  oauthError: string | null;
  oauthPendingContinue?: { displayName: string } | null;
  onSignIn: () => void;
  /** Stops waiting for the browser sign-in; shown while `oauthConnecting`. */
  onCancelSignIn?: () => void;
  onContinuePendingOauth?: () => void;
  localEndpoints: DiscoveredLocalLlm[];
  onUseLocalEndpoint: (endpoint: DiscoveredLocalLlm, modelId: string) => Promise<void>;
  onUseExisting: () => void;
  /** Rows experiments add, shown after the custom endpoint row. */
  extraRows?: React.ReactNode;
  onConnectLocalManual: () => void;
}

/** Connect-a-model choice list (ADR 0019): one row per path, recommended first. */
export const OnboardingHomeScreen: React.FC<OnboardingHomeScreenProps> = ({
  oauthProvider,
  oauthLoading,
  oauthConnecting,
  oauthError,
  oauthPendingContinue = null,
  onSignIn,
  onCancelSignIn,
  onContinuePendingOauth,
  localEndpoints,
  onUseLocalEndpoint,
  onUseExisting,
  extraRows,
  onConnectLocalManual,
}) => {
  const hasLocal = localEndpoints.length > 0;
  const showOauthRow = !oauthLoading && (oauthPendingContinue || oauthProvider);

  return (
    <div className="flex w-full flex-col gap-3">
      {showOauthRow && (
        <ChoiceRow
          recommended
          title={
            oauthPendingContinue
              ? `Continue with ${oauthPendingContinue.displayName}`
              : oauthProvider!.displayName
          }
          badge={
            oauthPendingContinue ? undefined : (
              <Pill variant="brand">Recommended</Pill>
            )
          }
          description={
            oauthPendingContinue
              ? 'Your API key is stored on this device. Choose a model to finish.'
              : 'Works in under a minute · many models · no GPU setup'
          }
          action={
            <div className="flex shrink-0 items-center gap-2">
              {oauthConnecting && !oauthPendingContinue && onCancelSignIn ? (
                <Button type="button" variant="outline" onClick={onCancelSignIn}>
                  Cancel
                </Button>
              ) : null}
              <Button
                type="button"
                variant="brand"
                disabled={oauthConnecting}
                onClick={oauthPendingContinue ? onContinuePendingOauth : onSignIn}
              >
                {oauthPendingContinue
                  ? 'Choose a model'
                  : oauthConnecting
                    ? 'Waiting for authorization…'
                    : `Sign in with ${oauthProvider!.displayName}`}
              </Button>
            </div>
          }
        >
          {oauthPendingContinue || !oauthProvider ? null : (
            <p className="text-xs text-fg-faint">{cloudInferenceNotice(oauthProvider.displayName)}</p>
          )}
          {oauthError ? <Callout variant="destructive">{oauthError}</Callout> : null}
        </ChoiceRow>
      )}

      {hasLocal && (
        <LocalLlmDiscoveryCards
          endpoints={localEndpoints}
          onUseEndpoint={onUseLocalEndpoint}
        />
      )}

      <ChoiceRow
        title="I already have a URL / API key"
        description="Any OpenAI-compatible endpoint"
        onSelect={onUseExisting}
      />
      {extraRows}
      {!hasLocal && (
        <ChoiceRow
          title="Connect a local server manually"
          description="Ollama, LM Studio, or another server on this machine"
          onSelect={onConnectLocalManual}
        />
      )}
    </div>
  );
};
