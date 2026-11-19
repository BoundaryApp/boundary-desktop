/**
 * The consumer's side of a shared service (ADR 0048 §5, §11): a listener on this Mac's loopback
 * that the stack registers as a Twenty workspace at `http://host.docker.internal:<port>`. Hermes's
 * MCP client sends it `POST /mcp` with one of two random tokens; the token picks the level, and
 * the call goes over the Circle to the provider's gateway, which swaps in this member's key.
 *
 * Hardened as ADR 0027 §2 requires: loopback only, a bearer token, and no Origin or foreign Host.
 * Every refusal is a JSON-RPC error with `application/json`, because Hermes's MCP client shows
 * that message to the agent and turns anything else into "Server returned an error response".
 * Logs carry metadata only (§13).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ShareLevel } from '../../../shared/serviceOffers';
import { checkAgentRequest, readLimitedBody } from '../hostBridge/requestGuard';
import type { ServiceCall } from './networkMessages';
import { SERVICE_MAX_BODY_BYTES } from './serviceGateway';

/** JSON-RPC's code for an error the server defines. */
const SERVER_ERROR = -32000;

export interface ServiceListenerOptions {
  /** The kept port; 0 picks a free one. Rejects with `EADDRINUSE` when it is taken. */
  port: number;
  /** Random tokens the stack holds as the workspace's `key_ro` and `key_rw`. */
  tokens: Record<ShareLevel, string>;
  /** The offer's key in the provider's `services` record. */
  service: string;
  /** For error text: the provider's name and what they share, such as "Ada" and "Twenty". */
  describe(): { provider: string; service: string };
  /** Sends the call to the provider. Rejects when the provider can't be reached. */
  call(request: ServiceCall, signal: AbortSignal): Promise<Response>;
  /** Metadata only. */
  log?(message: string, data: Record<string, unknown>): void;
}

export interface ServiceListener {
  port: number;
  close(): Promise<void>;
}

/** The request's JSON-RPC id, so an error can answer it. Null for a notification or a batch. */
function rpcId(body: unknown): string | number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function answer(res: http.ServerResponse, status: number, id: string | number | null, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: SERVER_ERROR, message } }));
}

/** The most of an oversized body the listener reads and drops so the client sees its 413. */
const DISCARD_MAX_BYTES = 8 * SERVICE_MAX_BODY_BYTES;

/** Reads a request body to its end and drops it. False when the request errors or is aborted. */
function discardBody(req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    req.on('end', () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('aborted', () => resolve(false));
    req.resume();
  });
}

/** The provider gateway's `{ error: { message } }`, or null when the body isn't that shape. */
async function gatewayMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    return typeof body.error?.message === 'string' ? body.error.message.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** Starts the listener on 127.0.0.1. */
export function startServiceListener(options: ServiceListenerOptions): Promise<ServiceListener> {
  const tokens = { [options.tokens.read]: 'read', [options.tokens.write]: 'write' };
  let port = options.port;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.log?.('shared service listener failed', { error: error instanceof Error ? error.name : 'unknown' });
      answer(res, 500, null, 'Boundary couldn’t pass this call on.');
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const checked = checkAgentRequest(req.headers, { port, tokens });
    if ('status' in checked) {
      req.resume();
      answer(res, checked.status, null, checked.reason);
      return;
    }
    const level = checked.agent as ShareLevel;
    const path = req.url ?? '/';
    if (path.split('?')[0].replace(/\/+$/, '') !== '/mcp') {
      req.resume();
      answer(res, 404, null, 'Not found.');
      return;
    }
    // Twenty keeps no MCP session and has no GET or DELETE route; the MCP client takes 405 as
    // "no server-sent stream" and carries on.
    if (req.method !== 'POST') {
      req.resume();
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    // A declared length over the cap is read and dropped before the 413 goes out. Closing while
    // the client is still uploading makes its next write fail with a reset, and it never reads
    // the answer. A declared length past DISCARD_MAX_BYTES, or a body that runs over without one,
    // is cut off.
    const declared = Number(req.headers['content-length']);
    if (declared > SERVICE_MAX_BODY_BYTES) {
      if (declared > DISCARD_MAX_BYTES || !(await discardBody(req))) {
        req.destroy();
        return;
      }
      res.setHeader('Connection', 'close');
      answer(res, 413, null, 'Request body is too large.');
      return;
    }
    const raw = await readLimitedBody(req, SERVICE_MAX_BODY_BYTES);
    if (raw === null) {
      answer(res, 413, null, 'Request body is too large.');
      return;
    }
    const body = raw.toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      answer(res, 400, null, 'Request body is not JSON.');
      return;
    }
    const id = rpcId(parsed);

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const accept = typeof req.headers.accept === 'string' ? req.headers.accept : undefined;
    const started = Date.now();
    const { provider, service } = options.describe();
    let response: Response;
    try {
      response = await options.call(
        { service: options.service, level, method: 'POST', path, ...(accept ? { accept } : {}), body },
        abort.signal
      );
    } catch {
      if (abort.signal.aborted) return;
      options.log?.('shared service unreachable', { service: options.service, level, ms: Date.now() - started });
      answer(
        res,
        503,
        id,
        `${provider}’s Mac is offline or not connected, so the ${service} they share can’t be reached. Try again once they’re online.`
      );
      return;
    }

    if (response.status >= 300) {
      const message = (await gatewayMessage(response)) ?? `HTTP ${response.status}`;
      options.log?.('shared service refused', { service: options.service, level, status: response.status, ms: Date.now() - started });
      answer(res, response.status, id, `${provider}’s ${service}: ${message}`);
      return;
    }

    res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
    if (!response.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
    res.on('finish', () =>
      options.log?.('shared service call', { service: options.service, level, status: response.status, ms: Date.now() - started })
    );
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
