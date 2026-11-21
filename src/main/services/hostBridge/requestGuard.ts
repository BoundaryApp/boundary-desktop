import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

/**
 * The checks every host-bridge request passes before anything else runs (ADR 0027 §2).
 *
 * Any container and any local process can reach the listener (host.docker.internal reaches
 * host loopback), so the token is the real gate. Origin and Host checks keep web pages out:
 * a browser always sends Origin on cross-site requests, and DNS rebinding arrives with a
 * foreign Host. Hermes's MCP client sends neither an Origin nor an unexpected Host.
 */

/** Why a request was refused; `null` from `checkBridgeRequest` means it passed. */
export interface GuardFailure {
  status: number;
  reason: string;
}

/** Host names a legitimate caller uses: the container alias and loopback. */
const ALLOWED_HOSTNAMES = ['host.docker.internal', '127.0.0.1', 'localhost'];

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time compare of a presented bearer token against the expected one. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

export function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (typeof value !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1] : undefined;
}

/**
 * `?token=` from a request URL. Only the browser listener accepts it: Hermes hands its CDP
 * driver a URL, not headers, and Hermes masks query strings in CDP URLs before logging them.
 */
export function queryToken(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, 'http://bridge.invalid').searchParams.get('token') ?? undefined;
  } catch {
    return undefined;
  }
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return ALLOWED_HOSTNAMES.some((name) => host.toLowerCase() === `${name}:${port}`);
}

const INVALID_TOKEN: GuardFailure = { status: 401, reason: 'Missing or invalid bearer token.' };

/** The Origin and Host checks, which come before any token check. */
function checkCaller(headers: IncomingHttpHeaders, port: number): GuardFailure | null {
  if (headers.origin !== undefined) {
    return { status: 403, reason: 'Requests from web pages are not accepted.' };
  }
  if (!hostAllowed(headers.host, port)) {
    return { status: 421, reason: 'Unexpected Host header.' };
  }
  return null;
}

export function checkBridgeRequest(
  headers: IncomingHttpHeaders,
  { port, token, url }: { port: number; token: string; /** Set to also accept `?token=`. */ url?: string }
): GuardFailure | null {
  const caller = checkCaller(headers, port);
  if (caller) return caller;
  if (!tokenMatches(bearerToken(headers) ?? queryToken(url), token)) return INVALID_TOKEN;
  return null;
}

/** The browser listener's path for the credential client; every other `/devtools/browser/…` path is the agent's. */
export const CREDENTIALS_BROWSER_PATH = '/devtools/browser/credentials';

/**
 * The browser listener's checks (ADR 0065). The token picks the client: the agent's token, or one
 * of the credential client's (the current one, and the previous one during a rotation's grace).
 * Each token opens only its own path, so a credential token can't be used as the agent's or the
 * other way round. Every token is compared, so the time taken doesn't depend on which matched.
 */
export function checkBrowserRequest(
  headers: IncomingHttpHeaders,
  { port, url, agentToken, credentialTokens }: { port: number; url: string | undefined; agentToken: string; credentialTokens: readonly string[] }
): { role: 'agent' | 'credentials' } | GuardFailure {
  const caller = checkCaller(headers, port);
  if (caller) return caller;
  const presented = bearerToken(headers) ?? queryToken(url);
  const agent = tokenMatches(presented, agentToken);
  let credentials = false;
  for (const token of credentialTokens) if (tokenMatches(presented, token)) credentials = true;
  const credentialsPath = (url ?? '').split('?')[0] === CREDENTIALS_BROWSER_PATH;
  if (agent && !credentialsPath) return { role: 'agent' };
  if (credentials && credentialsPath) return { role: 'credentials' };
  return INVALID_TOKEN;
}

/**
 * The same checks against a map of per-agent tokens (token → agent), bearer header only. Every
 * entry is compared, so the time taken doesn't depend on which one matched.
 */
export function checkAgentRequest(
  headers: IncomingHttpHeaders,
  { port, tokens }: { port: number; tokens: Readonly<Record<string, string>> }
): { agent: string } | GuardFailure {
  const caller = checkCaller(headers, port);
  if (caller) return caller;
  const presented = bearerToken(headers);
  let agent: string | null = null;
  for (const [token, owner] of Object.entries(tokens)) {
    if (tokenMatches(presented, token) && agent === null) agent = owner;
  }
  return agent === null ? INVALID_TOKEN : { agent };
}

/** A request body up to `maxBytes`; null (and the request dropped) when it is larger. */
export function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
