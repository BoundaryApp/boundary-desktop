import { OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';
import type { OAuthPkceProviderDefinition } from './types';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_TOKEN_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const OPENROUTER_ENDPOINT_URL = 'https://openrouter.ai/api/v1';

const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://boundary.local',
  'X-OpenRouter-Title': 'Boundary Desktop',
};

export const openRouterOAuthProvider: OAuthPkceProviderDefinition = {
  id: 'openrouter',
  displayName: 'OpenRouter',
  description: 'Sign in with OpenRouter to access 300+ models through one OpenAI-compatible endpoint.',
  authUrl: OPENROUTER_AUTH_URL,
  tokenExchangeUrl: OPENROUTER_TOKEN_EXCHANGE_URL,
  defaultEndpointUrl: OPENROUTER_ENDPOINT_URL,
  authScheme: 'bearer',
  capabilities: OAUTH_LLM_CAPABILITIES,
  buildAuthUrl({ callbackUrl, codeChallenge }) {
    const params = new URLSearchParams({
      callback_url: callbackUrl,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${OPENROUTER_AUTH_URL}?${params.toString()}`;
  },
  async exchangeCode({ code, codeVerifier, fetchImpl = fetch }) {
    const res = await fetchImpl(OPENROUTER_TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
    });

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(
        `OpenRouter authorization failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('OpenRouter returned a non-JSON authorization response.');
    }

    const key = (parsed as { key?: string }).key;
    if (!key?.trim()) {
      throw new Error('OpenRouter did not return an API key.');
    }

    return { apiKey: key.trim() };
  },
  modelListing: {
    extraHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
  },
  inferenceHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
};
