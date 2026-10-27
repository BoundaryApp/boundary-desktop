/**
 * The Authorization header for an OpenAI-compatible request: `Api-Key <key>` for Baseten or
 * an `api-key` scheme, `Bearer <key>` otherwise, and none without a key.
 */
export function llmAuthorizationHeader(options: {
  apiKey?: string | null;
  authScheme?: 'bearer' | 'api-key';
  provider?: string;
}): string | undefined {
  if (!options.apiKey) return undefined;
  const apiKeyScheme = options.authScheme === 'api-key' || options.provider === 'baseten';
  return `${apiKeyScheme ? 'Api-Key' : 'Bearer'} ${options.apiKey}`;
}
