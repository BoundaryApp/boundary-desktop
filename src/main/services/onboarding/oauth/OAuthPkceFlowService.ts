import { shell } from 'electron';
import { persistDebugLog } from '../../../persistDebugLog';
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

  const { port, waitForCode, close } = await startOAuthLoopbackServer({
    signal: abort.signal,
  });
  const callbackUrl = `http://127.0.0.1:${port}`;
  const authUrl = provider.buildAuthUrl({ callbackUrl, codeChallenge });

  try {
    await shell.openExternal(authUrl);
    persistDebugLog('oauth', 'browser opened', { providerId: provider.id, port });

    const { code } = await waitForCode();
    const { apiKey } = await provider.exchangeCode({ code, codeVerifier });
    persistDebugLog('oauth', 'code exchanged', { providerId: provider.id });

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
    close();
    if (activeAbort === abort) {
      activeAbort = null;
    }
  }
}
