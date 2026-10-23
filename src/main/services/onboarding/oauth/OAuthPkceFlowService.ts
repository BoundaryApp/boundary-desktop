import { shell } from 'electron';
import type { OAuthConnectionProviderId } from '../../../../shared/types/onboarding';
import { computeS256Challenge, generateCodeVerifier } from './pkce';
import { startOAuthLoopbackServer } from './OAuthLoopbackServer';
import { getOAuthProvider } from './registry';
import type { OAuthPkceFlowResult } from './types';

let activeAbort: AbortController | null = null;

export function cancelActiveOAuthPkceFlow(): void {
  activeAbort?.abort();
  activeAbort = null;
}

export async function startOAuthPkceFlow(
  providerId: OAuthConnectionProviderId
): Promise<OAuthPkceFlowResult> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }

  cancelActiveOAuthPkceFlow();
  const abort = new AbortController();
  activeAbort = abort;

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);

  const { port, waitForCode } = await startOAuthLoopbackServer({
    signal: abort.signal,
  });
  const callbackUrl = `http://127.0.0.1:${port}`;
  const authUrl = provider.buildAuthUrl({ callbackUrl, codeChallenge });

  await shell.openExternal(authUrl);

  try {
    const { code } = await waitForCode();
    const { apiKey } = await provider.exchangeCode({ code, codeVerifier });

    return {
      providerId: provider.id,
      providerDisplayName: provider.displayName,
      endpointUrl: provider.defaultEndpointUrl,
      apiKey,
      authScheme: provider.authScheme,
      capabilities: provider.capabilities,
      extraHeaders: provider.modelListing?.extraHeaders ?? provider.inferenceHeaders,
    };
  } finally {
    if (activeAbort === abort) {
      activeAbort = null;
    }
  }
}
