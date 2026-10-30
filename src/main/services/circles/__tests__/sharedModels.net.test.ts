import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CircleOfferView } from '../../../../shared/types/circles';
import { startChainRouter, ROUTER_SERVED_HEADER, type RouterChain } from '../../inference/router/chainRouter';
import { CircleNetwork } from '../circleNetwork';

/**
 * A shared model end to end (ADR 0034 §1–2): Ada shares a model from a stand-in model server on
 * 127.0.0.1, and Bo reaches it through the inference channel over a HyperDHT testnet. Waits on
 * change events and on the server's own requests, never a timer.
 */

interface Person {
  net: CircleNetwork;
  until(test: () => boolean): Promise<void>;
  /** Diagnostics events this person's network recorded. */
  events: Array<[string, Record<string, unknown>]>;
}

/** The stand-in model server: records requests, and holds a reply open when asked to. */
interface FakeServer {
  url: string;
  seen: Array<{ method: string; path: string; auth: string | undefined; body: string }>;
  /** Most chat requests in flight at once. */
  maxInFlight: number;
  /** Resolves when the next chat request arrives. */
  nextChat(): Promise<{ hold: () => void; closed: Promise<void> }>;
  close(): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let server: FakeServer;
const nets: CircleNetwork[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const events: Person['events'] = [];
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: () => waiters.forEach((wake) => wake()),
    diag: (event, data) => events.push([event, data]),
  });
  await net.ready();
  nets.push(net);
  return {
    net,
    events,
    until: (test) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!test()) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      }),
  };
}

async function fakeServer(): Promise<FakeServer> {
  const seen: FakeServer['seen'] = [];
  const arrivals: Array<(chat: { hold: () => void; closed: Promise<void> }) => void> = [];
  let inFlight = 0;
  const result: FakeServer = {
    url: '',
    seen,
    maxInFlight: 0,
    nextChat: () => new Promise((resolve) => arrivals.push(resolve)),
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data: Buffer) => (body += data.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'not-shared' }] }));
        return;
      }
      inFlight++;
      result.maxInFlight = Math.max(result.maxInFlight, inFlight);
      let held = false;
      const closed = new Promise<void>((resolve) => res.on('close', () => resolve()));
      res.on('close', () => inFlight--);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const model = (JSON.parse(body) as { model: string }).model;
      res.write(`data: {"model":"${model}","n":1}\n\n`);
      arrivals.shift()?.({ hold: () => (held = true), closed });
      // A held reply stays open until the client goes away.
      setImmediate(() => {
        if (held) return;
        res.write('data: {"n":2}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  result.url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/v1`;
  return result;
}

async function readAll(body: Readable): Promise<string> {
  let text = '';
  for await (const chunk of body) text += (chunk as Buffer).toString('utf8');
  return text;
}

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-share-'));
  server = await fakeServer();
});

afterAll(async () => {
  for (const net of nets) await net.close();
  await server.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('a shared model over a local DHT', () => {
  let ada: Person;
  let bo: Person;
  let key: string;
  let adaIdentity: string;
  let inviteCode: string;
  const offerOf = (p: Person): CircleOfferView | undefined =>
    p.net.snapshot().circles.find((circle) => circle.key === key)?.offers.find((offer) => offer.identity === adaIdentity);
  const chat = (model = 'qwen3-8b') => ({
    method: 'POST',
    path: '/v1/chat/completions',
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

  it('shows a member’s offer to the Circle, online', async () => {
    ada = await person('Ada');
    bo = await person('Bo');
    adaIdentity = ada.net.snapshot().identity;
    key = (await ada.net.createCircle('Workshop')).key!;
    inviteCode = (await ada.net.createInvite(key, Date.now() + 60 * 60_000)).code;
    await bo.net.joinCircle(inviteCode);

    ada.net.setShareUpstream({ baseUrl: server.url, apiKey: 'lm-key' });
    await ada.net.publishOffer(key, {
      models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }],
      available: true,
      away: false,
    });
    await bo.until(() => Boolean(offerOf(bo)?.online));
    expect(offerOf(bo)).toMatchObject({ name: 'Ada', isMine: false, models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }] });
    expect(offerOf(ada)).toMatchObject({ isMine: true, online: true });
  });

  it('lists only the offered model', async () => {
    const response = await bo.net.requestSharedModel(key, adaIdentity, { method: 'GET', path: '/v1/models' });
    expect(response.status).toBe(200);
    expect(JSON.parse(await readAll(response.body)).data.map((model: { id: string }) => model.id)).toEqual(['qwen3-8b']);
  });

  it('streams a chat reply from the provider’s server, with the server’s key', async () => {
    const response = await bo.net.requestSharedModel(key, adaIdentity, chat());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/event-stream');
    expect(await readAll(response.body)).toBe('data: {"model":"qwen3-8b","n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
    const forwarded = server.seen.at(-1)!;
    expect(forwarded).toMatchObject({ method: 'POST', path: '/v1/chat/completions', auth: 'Bearer lm-key' });
    expect(JSON.parse(forwarded.body).model).toBe('qwen3-8b');
  });

  it('refuses a model that isn’t offered without reaching the server', async () => {
    const before = server.seen.length;
    const response = await bo.net.requestSharedModel(key, adaIdentity, chat('not-shared'));
    expect(response.status).toBe(404);
    await readAll(response.body);
    expect(server.seen.length).toBe(before);
  });

  it('serves two requests one after the other, and stops one the consumer cancels', async () => {
    const first = server.nextChat();
    const abort = new AbortController();
    const held = bo.net.requestSharedModel(key, adaIdentity, chat(), abort.signal);
    const arrived = await first;
    arrived.hold();
    const queued = bo.net.requestSharedModel(key, adaIdentity, chat());

    const response = await held;
    response.body.on('error', () => undefined);
    abort.abort();
    // The provider's gateway stops the server request when the consumer cancels.
    await arrived.closed;
    const second = await queued;
    expect(await readAll(second.body)).toContain('[DONE]');
    expect(server.maxInFlight).toBe(1);
  });

  it('serves a router chain whose first entry is the shared model', async () => {
    const peer = { circleId: key, providerId: adaIdentity };
    const fallback = await fakeServer();
    const chain: RouterChain = {
      entries: [
        { entry: { slot: 'peer', modelId: 'qwen3-8b', peer }, key: 'shared', stale: null, private: false },
        { entry: { slot: 'local' }, key: 'local', stale: null, private: true },
      ],
      upstreams: {
        shared: { baseUrl: '', modelId: 'qwen3-8b', peer },
        local: { baseUrl: fallback.url, modelId: 'local-model' },
      },
      modelId: 'qwen3-8b',
    };
    // The same glue as circlesService.fetchSharedModel, without the process boundary.
    const router = await startChainRouter({
      token: 'test-token',
      getChain: () => chain,
      peerFetch: async (ref, body, signal) => {
        const reply = await bo.net.requestSharedModel(ref.circleId, ref.providerId, { method: 'POST', path: '/v1/chat/completions', body }, signal);
        // Like fetchSharedModel, drop what arrives after the router cancels a refused reply.
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            reply.body.on('data', (chunk: Buffer) => cancelled || controller.enqueue(new Uint8Array(chunk)));
            reply.body.on('end', () => cancelled || controller.close());
            reply.body.on('error', (err) => cancelled || controller.error(err));
          },
          cancel() {
            cancelled = true;
            reply.body.destroy();
          },
        });
        return new Response(stream, {
          status: reply.status,
          headers: { 'Content-Type': reply.contentType },
        });
      },
    });
    const send = () =>
      fetch(`http://127.0.0.1:${router.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-8b', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
    try {
      const served = await send();
      expect(served.headers.get(ROUTER_SERVED_HEADER)).toBe('shared');
      expect(await served.text()).toContain('"model":"qwen3-8b"');

      // Ada stops serving; the router moves on to the next entry.
      ada.net.setShareUpstream(null);
      const fellBack = await send();
      expect(fellBack.headers.get(ROUTER_SERVED_HEADER)).toBe('local');
      expect(await fellBack.text()).toContain('"model":"local-model"');
      ada.net.setShareUpstream({ baseUrl: server.url, apiKey: 'lm-key' });
    } finally {
      await router.close();
      await fallback.close();
    }
  });

  it('answers 503 once the offer is withdrawn', async () => {
    await ada.net.withdrawOffer(key);
    await bo.until(() => !offerOf(bo));
    const response = await bo.net.requestSharedModel(key, adaIdentity, chat());
    expect(response.status).toBe(503);
    await readAll(response.body);
  });

  it('leaves a diagnostics trail on both sides, without names, codes, keys or prompts', () => {
    const kinds = (p: Person) => new Set(p.events.map(([event]) => event));
    for (const event of ['net.ready', 'circle.created', 'invite.created', 'invite.admit', 'peer.connect', 'peer.replicate', 'link.open', 'circle.state', 'offer.published', 'share.upstream', 'gateway.request', 'gateway.queued', 'gateway.done', 'gateway.refused', 'gateway.cancel', 'circle.topic-flushed']) {
      expect(kinds(ada), event).toContain(event);
    }
    for (const event of ['join.request', 'join.paired', 'join.writable', 'peer.connect', 'link.open', 'shared.request', 'shared.head', 'shared.end', 'shared.cancel']) {
      expect(kinds(bo), event).toContain(event);
    }
    const admit = ada.events.find(([event]) => event === 'invite.admit')![1];
    expect(admit.result).toBe('added');
    const served = bo.events.filter(([event]) => event === 'shared.end').map(([, data]) => data);
    expect(served.some((data) => (data.bytes as number) > 0 && data.error === null)).toBe(true);

    const all = JSON.stringify([...ada.events, ...bo.events]);
    for (const secret of [inviteCode, key, adaIdentity, 'Workshop', '"Ada"', '"Bo"', 'lm-key', '"role"', '"content"']) {
      expect(all, secret).not.toContain(secret);
    }
    expect(ada.net.diagnostics()).toMatchObject({
      dht: { addr: expect.any(String), firewalled: expect.any(Boolean) },
      circles: [{ members: 2, online: 1, offers: [] }],
      gateway: { queued: 0, running: false },
    });
  });
});
