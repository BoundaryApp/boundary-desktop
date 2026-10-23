import type {
  LlmConnectionCapabilities,
  OAuthConnectionProviderId,
} from '../../../../shared/types/onboarding';

export interface OAuthPkceExchangeResult {
  apiKey: string;
}

export interface OAuthPkceProviderDefinition {
  id: OAuthConnectionProviderId;
  displayName: string;
  description: string;
  authUrl: string;
  tokenExchangeUrl: string;
  defaultEndpointUrl: string;
  authScheme: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  buildAuthUrl(params: { callbackUrl: string; codeChallenge: string }): string;
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    fetchImpl?: typeof fetch;
  }): Promise<OAuthPkceExchangeResult>;
  modelListing?: {
    extraHeaders?: Record<string, string>;
  };
  inferenceHeaders?: Record<string, string>;
}

export interface OAuthPkceFlowResult {
  providerId: OAuthConnectionProviderId;
  providerDisplayName: string;
  endpointUrl: string;
  apiKey: string;
  authScheme: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}
