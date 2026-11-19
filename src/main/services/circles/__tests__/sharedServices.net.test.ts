import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import crypto from 'hypercore-crypto';
import createTestnet from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICES_APP, type ServiceOfferRecord } from '../../../../shared/serviceOffers';
import { CircleNetwork } from '../circleNetwork';
import type { CircleRecordChange } from '../networkMessages';
import type { ServiceRequest } from '../serviceGateway';

/**
 * A shared service end to end (ADR 0048 §1–4): Ada offers her Twenty, stood in for by an MCP
 * endpoint on 127.0.0.1, and grants Bo access. Bo's calls reach it over the `service` channel with
 * his own key swapped in; Cy, a member with no grant, is refused. Waits on change events and on
 * the server's own requests, never a timer.
 */

interface Person {
  net: CircleNetwork;
  identity: string;
  until(test: () => boolean): Promise<void>;
  records: CircleRecordChange[];
}

interface FakeMcp {
  url: string;
  seen: Array<{ method: string; path: string; auth: string | undefined; accept: string | undefined; body: string }>;
  close(): Promise<void>;
}

const SERVICE = 'twenty.main';
const OFFER: ServiceOfferRecord = { kind: 'twenty', name: 'Workshop CRM', levels: ['read', 'write'], available: true, away: false };

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let mcp: FakeMcp;
const nets: CircleNetwork[] = [];

async function person(name: string): Promise<Person> {
  const waiters = new Set<() => void>();
  const records: CircleRecordChange[] = [];
  const wake = () => waiters.forEach((check) => check());
  const net = new CircleNetwork({
    storageDir: path.join(dir, name),
    identitySeed: crypto.randomBytes(32),
    deviceSeed: crypto.randomBytes(32),
    name,
    bootstrap: testnet.bootstrap.map((node: { host: string; port: number }) => `${node.host}:${node.port}`),
    onChange: wake,
    onRecord: (change) => {
      records.push(change);
      wake();
    },
  });
  await net.ready();
  net.setRecordApps([SERVICES_APP]);
  nets.push(net);
  return {
    net,
    identity: net.snapshot().identity,
    records,
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

/** Answers every `POST /mcp` with an event stream, as Twenty does when the client accepts one. */
async function fakeMcp(): Promise<FakeMcp> {
  const seen: FakeMcp['seen'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (data: Buffer) => (body += data.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, accept: req.headers.accept, body });
      const id = (JSON.parse(body) as { id: number }).id;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: message\ndata: {"jsonrpc":"2.0","id":${id},"result":{}}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readAll(body: Readable): Promise<string> {
  let text = '';
  for await (const chunk of body) text += (chunk as Buffer).toString('utf8');
  return text;
}

beforeAll(async () => {
  testnet = await createTestnet(4);
  dir = await mkdtemp(path.join(tmpdir(), 'boundary-circles-services-'));
  mcp = await fakeMcp();
});

afterAll(async () => {
  for (const net of nets) await net.close();
  await mcp.close();
  await testnet.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe('a shared service over a local DHT', () => {
  let ada: Person;
  let bo: Person;
  let cy: Person;
  let key: string;
  const call = (overrides: Partial<Omit<ServiceRequest, 'id' | 'circle'>> = {}): Omit<ServiceRequest, 'id' | 'circle'> => ({
    service: SERVICE,
    level: 'read',
    method: 'POST',
    path: '/mcp',
    accept: 'application/json, text/event-stream',
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'find_many_people', arguments: {} } }),
    ...overrides,
  });
  const offerSeen = (p: Person, available: boolean) =>
    p.records.some((r) => r.app === SERVICES_APP && r.key === SERVICE && r.identity === ada.identity && (r.value as ServiceOfferRecord | null)?.available === available);
  const online = (p: Person, name: string) =>
    Boolean(p.net.snapshot().circles.find((c) => c.key === key)?.members.find((m) => m.name === name)?.online);

  it('carries Ada’s offer to the Circle as a record', async () => {
    ada = await person('Ada');
    bo = await person('Bo');
    cy = await person('Cy');
    key = (await ada.net.createCircle('Workshop')).key!;
    await bo.net.joinCircle((await ada.net.createInvite(key, Date.now() + 60 * 60_000)).code);
    await cy.net.joinCircle((await ada.net.createInvite(key, Date.now() + 60 * 60_000)).code);

    await ada.net.setRecord(key, SERVICES_APP, 'member', SERVICE, OFFER);
    ada.net.setServiceSharing({
      upstreams: { [SERVICE]: { mcpUrl: mcp.url } },
      grants: [{ circle: key, service: SERVICE, identity: bo.identity, read: 'bo-read-key', write: 'bo-write-key' }],
    });
    await Promise.all([ada.until(() => offerSeen(ada, true)), bo.until(() => offerSeen(bo, true))]);
    await Promise.all([bo.until(() => online(bo, 'Ada')), cy.until(() => online(cy, 'Ada'))]);
  });

  it('forwards Bo’s read call with his read key and streams Twenty’s answer back', async () => {
    const response = await bo.net.requestService(key, ada.identity, call());
    expect(response.status).toBe(200);
    expect(response.contentType).toBe('text/event-stream');
    expect(await readAll(response.body)).toBe('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n');
    expect(mcp.seen.at(-1)).toMatchObject({
      method: 'POST',
      path: '/mcp',
      auth: 'Bearer bo-read-key',
      accept: 'application/json, text/event-stream',
    });
  });

  it('uses Bo’s write key for a write call', async () => {
    const response = await bo.net.requestService(key, ada.identity, call({ level: 'write' }));
    await readAll(response.body);
    expect(mcp.seen.at(-1)!.auth).toBe('Bearer bo-write-key');
  });

  it('refuses Cy, who has no grant, and any path but /mcp, without reaching Twenty', async () => {
    const before = mcp.seen.length;
    const cyResponse = await cy.net.requestService(key, ada.identity, call());
    expect(cyResponse.status).toBe(403);
    await readAll(cyResponse.body);
    const graphql = await bo.net.requestService(key, ada.identity, call({ path: '/graphql' }));
    expect(graphql.status).toBe(404);
    await readAll(graphql.body);
    expect(mcp.seen.length).toBe(before);
  });

  it('refuses Bo once Ada pauses the offer, and again once she takes his grant away', async () => {
    await ada.net.setRecord(key, SERVICES_APP, 'member', SERVICE, { ...OFFER, available: false });
    await ada.until(() => offerSeen(ada, false));
    const paused = await bo.net.requestService(key, ada.identity, call());
    expect(paused.status).toBe(503);
    await readAll(paused.body);

    await ada.net.setRecord(key, SERVICES_APP, 'member', SERVICE, OFFER);
    await ada.until(() => ada.records.filter((r) => r.app === SERVICES_APP && (r.value as ServiceOfferRecord | null)?.available).length >= 2);
    ada.net.setServiceSharing({ upstreams: { [SERVICE]: { mcpUrl: mcp.url } }, grants: [] });
    const revoked = await bo.net.requestService(key, ada.identity, call());
    expect(revoked.status).toBe(403);
    await readAll(revoked.body);
  });
});
