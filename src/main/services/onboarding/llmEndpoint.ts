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

/**
 * The headers an OpenAI-compatible request to a connection carries: Content-Type (unless
 * `contentType` is false, for a GET), the authorization header from `llmAuthorizationHeader`
 * and the connection's `extraHeaders`. The authorization header wins over an extra header of
 * the same name.
 */
export function llmRequestHeaders(
  connection: {
    apiKey?: string | null;
    authScheme?: 'bearer' | 'api-key';
    provider?: string;
    extraHeaders?: Record<string, string>;
  },
  options: { contentType?: boolean } = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(options.contentType === false ? {} : { 'Content-Type': 'application/json' }),
    ...connection.extraHeaders,
  };
  const authorization = llmAuthorizationHeader(connection);
  if (authorization) headers.Authorization = authorization;
  return headers;
}
