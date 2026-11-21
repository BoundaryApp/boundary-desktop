import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PinMismatchError, pinnedFetch as pinnedFetchPair } from '../pinnedFetch';

const pinnedFetch = (fingerprint: string, opts?: { ca?: string }): typeof fetch => pinnedFetchPair(fingerprint, opts).fetch;

/**
 * The pinned fetch against a local HTTPS server with a committed self-signed certificate for
 * localhost. The test passes that certificate as the trusted CA, so normal validation passes and
 * only the fingerprint decides.
 */

const tlsDir = path.join(__dirname, 'fixtures', 'tls');
const cert = readFileSync(path.join(tlsDir, 'localhost-cert.pem'), 'utf8');
const key = readFileSync(path.join(tlsDir, 'localhost-key.pem'), 'utf8');
// Worked out here with node:crypto, independently of the code under test.
const FP = createHash('sha256')
  .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex');
const OTHER_FP = 'e5db636af31d94d74871ab63d5e62ac2d34beab02032629dac2685149b7d99d7';

type Handler = (req: { method: string; url: string; headers: Record<string, unknown>; body: string }, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler;
let requests: number;
let sockets: Socket[];
/** Per TLS connection, whether it resumed an earlier session (which skips the pin check). */
let resumed: boolean[];

beforeEach(async () => {
  requests = 0;
  sockets = [];
  resumed = [];
  handler = (_req, res): void => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  server = createServer({ cert, key }, (req, res) => {
    requests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }, res));
  });
  server.on('connection', (socket: Socket) => sockets.push(socket));
  server.on('secureConnection', (socket: TLSSocket) => resumed.push(socket.isSessionReused()));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `https://localhost:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('pinnedFetch', () => {
  it('serves a request when the certificate’s key matches the pin', async () => {
    let seen: Parameters<Handler>[0] | null = null;
    handler = (req, res): void => {
      seen = req;
      res.writeHead(201, { 'content-type': 'application/json', 'x-extra': 'yes' });
      res.end('{"answer":42}');
    };
    const fetchPinned = pinnedFetch(FP, { ca: cert });
    const res = await fetchPinned(`${base}/v1/chat/completions?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.headers.get('x-extra')).toBe('yes');
    expect(await res.json()).toEqual({ answer: 42 });
    expect(seen).toMatchObject({ method: 'POST', url: '/v1/chat/completions?x=1', body: '{"hello":"world"}' });
    expect(seen!.headers.authorization).toBe('Bearer test');
  });

  it('accepts the pin in upper case', async () => {
    const res = await pinnedFetch(FP.toUpperCase(), { ca: cert })(`${base}/`, { method: 'GET' });
    expect(res.status).toBe(200);
    await res.text();
  });

  it('refuses a certificate whose key doesn’t match, before sending anything', async () => {
    await expect(pinnedFetch(OTHER_FP, { ca: cert })(`${base}/`, { method: 'POST', body: 'secret' })).rejects.toThrow(PinMismatchError);
    expect(requests).toBe(0);
  });

  it('writes no application byte to a server whose key doesn’t match', async () => {
    // A bare TLS server: every byte the client sends after the handshake is recorded.
    const received: Buffer[] = [];
    const closed: Promise<void>[] = [];
    const raw = createTlsServer({ cert, key }, (socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk));
      socket.on('error', () => undefined);
      closed.push(new Promise<void>((resolve) => socket.on('close', () => resolve())));
    });
    await new Promise<void>((resolve) => raw.listen(0, '127.0.0.1', resolve));
    try {
      const url = `https://localhost:${(raw.address() as AddressInfo).port}/v1/chat/completions`;
      const sent = pinnedFetch(OTHER_FP, { ca: cert })(url, { method: 'POST', headers: { authorization: 'Bearer SECRETMARKER' }, body: 'secret prompt' });
      await expect(sent).rejects.toThrow(PinMismatchError);
      await Promise.all(closed);
      expect(Buffer.concat(received).length).toBe(0);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  it('reuses a connection, and close() closes it while a later request still works', async () => {
    const pair = pinnedFetchPair(FP, { ca: cert });
    await (await pair.fetch(`${base}/`, { method: 'GET' })).text();
    await (await pair.fetch(`${base}/`, { method: 'GET' })).text();
    expect(sockets).toHaveLength(1);
    const first = sockets[0];
    const firstClosed = new Promise<void>((resolve) => first.on('close', () => resolve()));
    pair.close();
    await firstClosed;
    const res = await pair.fetch(`${base}/`, { method: 'GET' });
    expect(await res.json()).toEqual({ ok: true });
    expect(sockets).toHaveLength(2);
    expect(resumed).toEqual([false, false]);
    // Pooling has stopped, so the later connection closes once its request is done.
    await new Promise<void>((resolve) => (sockets[1].destroyed ? resolve() : sockets[1].on('close', () => resolve())));
  });

  it('lets a request that is running when close() is called finish', async () => {
    let finish: () => void = () => undefined;
    handler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('one ');
      finish = (): void => {
        res.end('two');
      };
    };
    const pair = pinnedFetchPair(FP, { ca: cert });
    const res = await pair.fetch(`${base}/`, { method: 'GET' });
    pair.close();
    finish();
    expect(await res.text()).toBe('one two');
  });

  it('still validates the certificate: an untrusted one is refused even with the right pin', async () => {
    await expect(pinnedFetch(FP)(`${base}/`, { method: 'GET' })).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it('refuses a malformed pin without connecting', () => {
    expect(() => pinnedFetch('not-hex', { ca: cert })).toThrow();
  });

  it('refuses plain http', async () => {
    await expect(pinnedFetch(FP, { ca: cert })(`http://localhost:1/`, { method: 'GET' })).rejects.toThrow();
  });

  it('rejects at once when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(pinnedFetch(FP, { ca: cert })(`${base}/`, { method: 'GET', signal: controller.signal })).rejects.toThrow();
    expect(requests).toBe(0);
  });

  it('aborts while waiting for the head', async () => {
    const controller = new AbortController();
    handler = (): void => {
      controller.abort();
    };
    await expect(pinnedFetch(FP, { ca: cert })(`${base}/`, { method: 'GET', signal: controller.signal })).rejects.toThrow();
  });

  it('errors the body when aborted mid-stream', async () => {
    const controller = new AbortController();
    handler = (_req, res): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
    };
    const res = await pinnedFetch(FP, { ca: cert })(`${base}/`, { method: 'GET', signal: controller.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n');
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  it('gives a body-less response for 204', async () => {
    handler = (_req, res): void => {
      res.writeHead(204);
      res.end();
    };
    const res = await pinnedFetch(FP, { ca: cert })(`${base}/`, { method: 'GET' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});
