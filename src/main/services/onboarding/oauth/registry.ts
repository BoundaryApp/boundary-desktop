import type { OAuthConnectionProviderId } from '../../../../shared/types/onboarding';
import { openRouterOAuthProvider } from './OpenRouterOAuthProvider';
import type { OAuthPkceProviderDefinition } from './types';

const providers = new Map<OAuthConnectionProviderId, OAuthPkceProviderDefinition>([
  [openRouterOAuthProvider.id, openRouterOAuthProvider],
]);

export function registerOAuthProvider(provider: OAuthPkceProviderDefinition): void {
  providers.set(provider.id, provider);
}

export function listOAuthProviders(): OAuthPkceProviderDefinition[] {
  return Array.from(providers.values());
}

export function getOAuthProvider(
  id: OAuthConnectionProviderId
): OAuthPkceProviderDefinition | undefined {
  return providers.get(id);
}
