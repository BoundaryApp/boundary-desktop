import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

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

export function checkBridgeRequest(
  headers: IncomingHttpHeaders,
  { port, token, url }: { port: number; token: string; /** Set to also accept `?token=`. */ url?: string }
): GuardFailure | null {
  if (headers.origin !== undefined) {
    return { status: 403, reason: 'Requests from web pages are not accepted.' };
  }
  if (!hostAllowed(headers.host, port)) {
    return { status: 421, reason: 'Unexpected Host header.' };
  }
  if (!tokenMatches(bearerToken(headers) ?? queryToken(url), token)) {
    return { status: 401, reason: 'Missing or invalid bearer token.' };
  }
  return null;
}
