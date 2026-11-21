/**
 * A `fetch` over `node:https` that only talks to a server whose certificate carries one public
 * key: the TLS key Tinfoil's attestation endorsed, given as the SHA-256 of its
 * SubjectPublicKeyInfo. The normal certificate and hostname checks run first, then the key check.
 * A new connection is handed to a request only after its handshake and both checks have passed,
 * so no request byte is written to a connection that failed them. Connections are pooled per pin,
 * so a reused connection was checked when it opened. TLS sessions aren't resumed: Node skips
 * `checkServerIdentity` on a resumed session, so every new connection does a full handshake.
 */
import { createHash, X509Certificate } from 'node:crypto';
import type { ClientRequestArgs } from 'node:http';
import { Agent, request, type RequestOptions } from 'node:https';
import { Readable, type Duplex } from 'node:stream';
import { checkServerIdentity, type PeerCertificate, type TLSSocket } from 'node:tls';

const FP_RE = /^[0-9a-f]{64}$/;
/** Statuses whose response has no body. */
const NO_BODY = new Set([204, 205, 304]);

export interface PinnedFetchOptions {
  /** Extra trusted CA certificates (PEM). Tests pass their self-signed certificate. */
  ca?: string;
}

/** A fetch pinned to one TLS key, and `close`, which stops it keeping connections open. */
export interface PinnedFetch {
  fetch: typeof fetch;
  /**
   * Closes idle pooled connections and stops pooling: a request still running finishes, and its
   * connection closes when it does. A later request still works, on a connection of its own.
   */
  close: () => void;
}

/** The server's certificate carries another key than the attested one. */
export class PinMismatchError extends Error {
  constructor() {
    super('The server’s TLS key isn’t the attested one');
    this.name = 'PinMismatchError';
  }
}

/** The SHA-256 of a DER certificate's SubjectPublicKeyInfo, lowercase hex. */
function spkiFingerprint(raw: Buffer): string {
  const spki = new X509Certificate(raw).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

function headerList(init: RequestInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

function responseHeaders(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  return headers;
}

type Created = (err: Error | null, stream: Duplex) => void;

/**
 * An agent whose new connections reach a request only once their handshake is done. The pin is
 * checked in `checkServerIdentity`, which fails the handshake on a mismatch.
 */
class PinnedAgent extends Agent {
  private closed = false;

  constructor(pin: string, ca: string | undefined) {
    super({
      keepAlive: true,
      maxCachedSessions: 0,
      ...(ca ? { ca } : {}),
      checkServerIdentity(host: string, cert: PeerCertificate): Error | undefined {
        const failed = checkServerIdentity(host, cert);
        if (failed) return failed;
        try {
          if (spkiFingerprint(cert.raw) === pin) return undefined;
        } catch {
          // Unreadable certificate: refused below.
        }
        return new PinMismatchError();
      },
    });
  }

  /**
   * Opens the TLS connection and passes it on through `created` after `secureConnect`. Node's
   * agent waits for the callback when this returns nothing.
   */
  override createConnection(options: ClientRequestArgs, created?: Created): Duplex {
    const socket = (super.createConnection as (o: ClientRequestArgs) => TLSSocket).call(this, options);
    const onError = (err: Error): void => {
      socket.off('secureConnect', onSecure);
      created?.(err, socket);
    };
    const onSecure = (): void => {
      socket.off('error', onError);
      created?.(null, socket);
    };
    socket.once('error', onError);
    socket.once('secureConnect', onSecure);
    return undefined as unknown as Duplex;
  }

  override keepSocketAlive(socket: Duplex): boolean {
    if (this.closed) return false;
    return (super.keepSocketAlive as (s: Duplex) => boolean).call(this, socket);
  }

  close(): void {
    this.closed = true;
    for (const list of Object.values(this.freeSockets)) for (const socket of list ?? []) socket.destroy();
  }
}

/**
 * A fetch pinned to `fingerprint` (64 hex characters). It takes a URL string and `method`,
 * `headers`, a string `body` and `signal`; anything else in `init` is ignored. Only `https:` URLs
 * are fetched. A key that doesn't match rejects with `PinMismatchError`.
 */
export function pinnedFetch(fingerprint: string, opts: PinnedFetchOptions = {}): PinnedFetch {
  const pin = fingerprint.toLowerCase();
  if (!FP_RE.test(pin)) throw new Error('TLS pin isn’t a SHA-256 fingerprint');
  const agent = new PinnedAgent(pin, opts.ca);

  const fetchPinned = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.protocol !== 'https:') return Promise.reject(new Error('Pinned fetch needs https'));
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const options: RequestOptions = {
      agent,
      method: init?.method ?? 'GET',
      headers: headerList(init),
      ...(signal ? { signal } : {}),
    };

    return new Promise<Response>((resolve, reject) => {
      const req = request(url, options, (res) => {
        const status = res.statusCode ?? 0;
        const headers = responseHeaders(res.headers);
        if (NO_BODY.has(status)) {
          res.resume();
          resolve(new Response(null, { status, headers }));
          return;
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }) as typeof fetch;

  return { fetch: fetchPinned, close: () => agent.close() };
}
