import { useCallback, useRef, useState } from 'react';
import type {
  DiscoveredLocalLlm,
  InferenceSlotId,
  OAuthConnectionProviderId,
  OAuthPkceCredentialsBundle,
} from '../../shared/types/onboarding';

/** The message every "Test" button sends, so the answer means the same thing everywhere. */
const LLM_TEST_MESSAGE = 'Reply with the word ready.';

export type OAuthSignInOutcome =
  | { kind: 'signed-in'; credentials: OAuthPkceCredentialsBundle }
  | { kind: 'failed'; error?: string }
  /** The user pressed Cancel while the browser was open; the caller shows nothing. */
  | { kind: 'cancelled' };

/**
 * The browser sign-in: start PKCE, remember a Cancel so a late answer is dropped, and tell main to
 * stop waiting. `connecting` is true while main waits for the browser to return.
 */
export function useOAuthSignIn(providerId: OAuthConnectionProviderId | null | undefined) {
  const [connecting, setConnecting] = useState(false);
  const cancelled = useRef(false);

  const signIn = useCallback(async (): Promise<OAuthSignInOutcome | null> => {
    if (!providerId) return null;
    cancelled.current = false;
    setConnecting(true);
    try {
      const result = await window.electronAPI.onboarding.startOAuthPkce({ providerId });
      if (cancelled.current) return { kind: 'cancelled' };
      if (!result.success || !result.credentials) return { kind: 'failed', error: result.error };
      return { kind: 'signed-in', credentials: result.credentials };
    } finally {
      setConnecting(false);
    }
  }, [providerId]);

  const cancel = useCallback(() => {
    cancelled.current = true;
    void window.electronAPI.onboarding.cancelOAuthPkce();
  }, []);

  return { connecting, signIn, cancel };
}

/**
 * The `saveLlmConnection` payload for a signed-in provider. A fresh key from the exchange is sent
 * only when `withApiKey` is set; otherwise main keeps the key it already stored.
 */
export function connectionFromCredentials(
  credentials: OAuthPkceCredentialsBundle,
  modelId: string,
  options: { slot?: 'local' | 'openrouter'; withApiKey?: boolean } = {}
) {
  return {
    endpointUrl: credentials.endpointUrl,
    ...(options.withApiKey ? { apiKey: credentials.apiKey } : {}),
    modelId,
    provider: credentials.providerId,
    providerDisplayName: credentials.providerDisplayName,
    authScheme: credentials.authScheme,
    capabilities: credentials.capabilities,
    extraHeaders: credentials.extraHeaders,
    ...(options.slot ? { slot: options.slot } : {}),
  };
}

/** Uses a discovered local server with a model; the result is the status result to take. */
export function adoptLocalLlm(endpoint: DiscoveredLocalLlm, modelId: string) {
  return window.electronAPI.onboarding.adoptLocalLlm({
    runtime: endpoint.runtime,
    endpointUrl: endpoint.baseUrl,
    modelId,
  });
}

/** Asks a configured slot for a short reply. */
export function testSlot(slot: InferenceSlotId) {
  return window.electronAPI.onboarding.sendLlmTestMessage({ slot, message: LLM_TEST_MESSAGE });
}

/** The saved pick when the list still has it, else the first model, else `fallback`. */
export function keepOrFirstModel(
  models: readonly { id: string }[],
  keep: string | undefined,
  fallback = ''
): string {
  return (keep && models.some((model) => model.id === keep) && keep) || models[0]?.id || fallback;
}
