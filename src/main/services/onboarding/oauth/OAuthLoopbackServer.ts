import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { persistDebugLog } from '../../../persistDebugLog';
import { APP_NAME } from '../../../../shared/buildIdentity';

/** OpenRouter's codes live 10 minutes, and a signed-out user has to sign in before getting one. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface OAuthLoopbackResult {
  code: string;
  port: number;
}

export interface StartOAuthLoopbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OAuthLoopbackServer {
  port: number;
  waitForCode: () => Promise<OAuthLoopbackResult>;
  close: () => void;
}

/**
 * Resolves once 127.0.0.1 is accepting connections on an OS-assigned port, so the caller can
 * send the browser there without a race. The port differs on every attempt. Logs carry the
 * request's path and parameter names, never its values: the code buys an API key.
 */
export async function startOAuthLoopbackServer(
  options: StartOAuthLoopbackOptions = {}
): Promise<OAuthLoopbackServer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;

  let settle: {
    resolve: (result: OAuthLoopbackResult) => void;
    reject: (error: Error) => void;
  };
  const result = new Promise<OAuthLoopbackResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The caller may leave before it waits, as when the browser can't open.
  result.catch((): void => undefined);

  let settled = false;
  let requests = 0;
  let port = 0;
  const finish = (outcome: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
    outcome();
  };

  const server = http.createServer((req, res) => {
    requests += 1;
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = requestUrl.searchParams.get('code');
    persistDebugLog('oauth', 'callback request', {
      port,
      pathname: requestUrl.pathname,
      params: [...requestUrl.searchParams.keys()],
      elapsedMs: elapsedMs(),
    });
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>Missing authorization code.</p></body></html>');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<html><body><p>Authorization complete. You can close this tab and return to ${APP_NAME}.</p></body></html>`
    );
    finish(() => settle.resolve({ code, port }));
  });

  const onAbort = () => {
    persistDebugLog('oauth', 'callback wait cancelled', { port, requests, elapsedMs: elapsedMs() });
    finish(() => settle.reject(new Error('OAuth authorization was cancelled.')));
  };
  const timeout = setTimeout(() => {
    persistDebugLog('oauth', 'callback wait timed out', { port, requests, elapsedMs: elapsedMs() });
    finish(() => settle.reject(new Error('OAuth authorization timed out. Try again.')));
  }, timeoutMs);

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      finish(() => settle.reject(error));
      reject(error);
    });
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  server.on('error', (error) => finish(() => settle.reject(error)));
  persistDebugLog('oauth', 'callback listener up', { port, timeoutMs });

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  return {
    port,
    waitForCode: () => result,
    close: () => finish(() => settle.reject(new Error('OAuth authorization was closed.'))),
  };
}
