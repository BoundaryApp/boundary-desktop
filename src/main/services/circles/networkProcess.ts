/**
 * Entry point of the Circles network utilityProcess (ADR 0032 §1), bundled to
 * `.vite/build/circlesNetwork.js`. Hyperswarm, Corestore and Autobase stay external: their native
 * addons resolve prebuilds next to their own package folders, which a bundle would lose.
 *
 * `circles-start` runs the user's Circles (circleNetwork.ts). `start` is the phase 0 packaging
 * spike: it reports which native addons loaded, and in `seed` or `replicate` mode joins one
 * Hypercore's topic and replicates it.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import Autobase from 'autobase';
import Corestore, { type Hypercore } from 'corestore';
import Hyperswarm from 'hyperswarm';
import { CircleNetwork } from './circleNetwork';
import type {
  CircleSecrets,
  CirclesRequest,
  MainToNetwork,
  NetworkSpikeMode,
  NetworkToMain,
} from './networkMessages';
import { runUnorderedProbe } from './unorderedProbe';

/** The addons ADR 0032 names; the process is no use without any of them. */
const REQUIRED_ADDONS = ['sodium-native', 'udx-native', 'rocksdb-native'];

const port = process.parentPort;
let store: Corestore | null = null;
let swarm: Hyperswarm | null = null;
let base: Autobase | null = null;
let circles: CircleNetwork | null = null;
let stopping = false;

function post(message: NetworkToMain): void {
  port.postMessage(message);
}

function log(message: string, data?: Record<string, unknown>): void {
  post({ type: 'log', message, data });
}

function diag(event: string, data: Record<string, unknown> = {}): void {
  post({ type: 'diag', at: Date.now(), event, data });
}

/** How often the health record goes out while Circles run. */
const HEARTBEAT_MS = 60_000;
let heartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Once a minute: the network's shape plus how the process is doing. Event-loop lag is how late
 * this timer fired, which shows a process too busy to answer peers.
 */
function startHeartbeat(net: CircleNetwork): void {
  let expected = Date.now() + HEARTBEAT_MS;
  heartbeat = setInterval(() => {
    const now = Date.now();
    const memory = process.memoryUsage();
    diag('net.heartbeat', {
      lagMs: Math.max(0, now - expected),
      rssMb: Math.round(memory.rss / 2 ** 20),
      heapMb: Math.round(memory.heapUsed / 2 ** 20),
      sharedCalls: sharedCalls.size,
      ...net.diagnostics(),
    });
    expected = now + HEARTBEAT_MS;
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

/** require-addon wraps a failed dlopen; its cause names the real problem. */
function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

/**
 * Native addons in the CommonJS module cache, by package name. require-addon loads each
 * `prebuilds/<platform>-<arch>/<name>.node` through `require`, so a loaded addon is cached there.
 */
function loadedAddons(): { names: string[]; files: string[] } {
  const files = Object.keys(createRequire(import.meta.url).cache).filter((file) => file.endsWith('.node'));
  return { names: files.map((file) => path.basename(file, '.node')).sort(), files };
}

/** Opening the store opens RocksDB, its keys use sodium, and the swarm's DHT binds UDX sockets. */
async function openNetwork(storageDir: string, bootstrap: string[] | undefined, probe: boolean): Promise<void> {
  store = new Corestore(path.join(storageDir, 'corestore'));
  await store.ready();
  swarm = new Hyperswarm(bootstrap ? { bootstrap } : {});
  swarm.on('connection', (connection, peer) => {
    store?.replicate(connection);
    log('peer connected', { peer: peer.publicKey.toString('hex').slice(0, 12), peers: swarm?.connections.size });
    connection.once('close', () => log('peer disconnected', { peers: swarm?.connections.size }));
    connection.on('error', (err: unknown) => log('peer connection error', { error: errorMessage(err) }));
    if (probe) runUnorderedProbe(connection, (summary) => log('unordered probe', { ...summary }));
  });
  // A local single-writer Autobase, to show the module runs here too; nothing replicates it.
  base = new Autobase(store.namespace('autobase-spike'), null, {
    open: (viewStore) => viewStore.get({ name: 'view' }),
    apply: async (nodes, view) => {
      for (const node of nodes) await view.append(JSON.stringify(node.value));
    },
    valueEncoding: 'json',
  });
  await base.ready();
  log('autobase ready', { writable: base.writable, isIndexer: base.isIndexer });
}

async function logBlocks(core: Hypercore, from: number): Promise<number> {
  for (let index = from; index < core.length; index++) {
    const block = await core.get(index);
    log('block', { index, text: block?.toString('utf8') ?? null });
  }
  return core.length;
}

async function seed(): Promise<void> {
  const core = store!.get({ name: 'circles-spike' });
  await core.ready();
  await core.append(`Boundary circles spike block ${core.length}, written ${new Date().toISOString()}`);
  log('seeding hypercore', { key: core.key.toString('hex'), length: core.length });
  await swarm!.join(core.discoveryKey, { server: true, client: true }).flushed();
  log('announced on topic', { discoveryKey: core.discoveryKey.toString('hex') });
}

async function replicate(keyHex: string): Promise<void> {
  const core = store!.get({ key: Buffer.from(keyHex, 'hex') });
  await core.ready();
  swarm!.join(core.discoveryKey, { server: true, client: true });
  // update() waits for peers while a search is running, so the first update sees the seed's length.
  const searched = core.findingPeers();
  void swarm!.flush().then(searched);
  log('looking for peers', { discoveryKey: core.discoveryKey.toString('hex') });
  await core.update();
  let logged = await logBlocks(core, 0);
  log('replicated', { length: core.length });
  core.on('append', () => {
    void logBlocks(core, logged).then((length) => {
      logged = length;
      log('replicated', { length });
    });
  });
}

async function start(storageDir: string, mode: NetworkSpikeMode, bootstrap: string[] | undefined): Promise<void> {
  // Seed and replicate also measure unordered messages on each connection (unorderedProbe.ts).
  await openNetwork(storageDir, bootstrap, mode.kind !== 'load');
  const addons = loadedAddons();
  const missing = REQUIRED_ADDONS.filter((name) => !addons.names.includes(name));
  log('native addons loaded', { addons: addons.names, files: addons.files });
  post({ type: 'addons', loaded: addons.names, missing });
  if (missing.length > 0) return;
  if (mode.kind === 'seed') await seed();
  if (mode.kind === 'replicate') await replicate(mode.key);
}

async function startCircles(message: Extract<MainToNetwork, { type: 'circles-start' }>): Promise<void> {
  let pending = false;
  const net = new CircleNetwork({
    storageDir: message.storageDir,
    identitySeed: Buffer.from(message.identitySeed, 'hex'),
    deviceSeed: Buffer.from(message.deviceSeed, 'hex'),
    name: message.name,
    bootstrap: message.bootstrap,
    // Changes come in bursts (an update, then peers); send one snapshot per turn of the loop.
    onChange: () => {
      if (pending) return;
      pending = true;
      setImmediate(() => {
        pending = false;
        if (circles) post({ type: 'circles-snapshot', snapshot: circles.snapshot() });
      });
    },
    onSignal: (signal) => post({ type: 'signal-received', signal }),
    onPaired: (secrets) => post({ type: 'circle-paired', secrets }),
    onRemoved: (key) => post({ type: 'circle-removed', key }),
    log,
    diag,
  });
  const started = Date.now();
  await net.ready();
  circles = net;
  for (const secrets of message.circles) {
    // One Circle that won't open shouldn't keep the others offline.
    await net.openCircle(secrets).catch((err: unknown) => {
      log('circle failed to open', { circle: secrets.key?.slice(0, 12) ?? null, error: errorMessage(err) });
    });
  }
  post({ type: 'circles-ready', snapshot: net.snapshot() });
  diag('net.circles-open', { circles: message.circles.length, ms: Date.now() - started, ...net.diagnostics() });
  startHeartbeat(net);
}

/** Runs one request; a created or joined Circle returns its secrets, an invite its code. */
async function handleCircles(
  request: CirclesRequest
): Promise<CircleSecrets | { id: string; code: string; expires: number } | void> {
  const net = circles;
  if (!net) throw new Error('Circles are not running.');
  switch (request.op) {
    case 'create':
      return net.createCircle(request.name);
    case 'join':
      return net.joinCircle(request.code);
    case 'invite':
      return net.createInvite(request.key, request.expiresAt);
    case 'revoke-invite':
      return net.revokeInvite(request.key, request.inviteId);
    case 'set-role':
      return net.setRole(request.key, request.identity, request.role);
    case 'remove-member':
      return net.removeMember(request.key, request.identity);
    case 'leave':
      return net.leaveCircle(request.key);
    case 'set-name':
      return net.setName(request.name);
    case 'publish-offer':
      return net.publishOffer(request.key, request.offer);
    case 'withdraw-offer':
      return net.withdrawOffer(request.key);
    case 'share-upstream':
      return net.setShareUpstream(request.upstream);
  }
}

/** Shared-model calls in flight, by main's id, so main can cancel them. */
const sharedCalls = new Map<number, AbortController>();

async function runSharedCall(message: Extract<MainToNetwork, { type: 'shared-request' }>): Promise<void> {
  const { id } = message;
  const abort = new AbortController();
  sharedCalls.set(id, abort);
  try {
    const net = circles;
    if (!net) throw new Error('Circles are not running.');
    const response = await net.requestSharedModel(message.key, message.provider, message.request, abort.signal);
    post({ type: 'shared-head', id, status: response.status, contentType: response.contentType });
    try {
      for await (const chunk of response.body) post({ type: 'shared-chunk', id, data: chunk as Buffer });
      post({ type: 'shared-end', id });
    } catch (err) {
      post({ type: 'shared-end', id, error: errorMessage(err) });
    }
  } catch (err) {
    post({ type: 'shared-end', id, error: errorMessage(err) });
  } finally {
    sharedCalls.delete(id);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (heartbeat) clearInterval(heartbeat);
  if (circles) diag('net.stopping', circles.diagnostics());
  // In order: the Autobase closes its sessions on the store, which fails once the store is closed.
  const errors: string[] = [];
  for (const close of [() => circles?.close(), () => swarm?.destroy(), () => base?.close(), () => store?.close()]) {
    try {
      await close();
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  if (errors.length > 0) log('close failed', { errors });
  post({ type: 'stopped' });
  // The parent port keeps the process alive; leave once the swarm and store are closed.
  setImmediate(() => process.exit(0));
}

port.on('message', (event: { data: MainToNetwork }) => {
  const message = event.data;
  switch (message.type) {
    case 'start':
      if (store) return;
      start(message.storageDir, message.mode, message.bootstrap).catch((err: unknown) => {
        post({ type: 'start-failed', error: errorMessage(err), addons: loadedAddons().names });
      });
      return;
    case 'circles-start':
      if (circles || store) return;
      startCircles(message).catch((err: unknown) => {
        post({ type: 'start-failed', error: errorMessage(err), addons: loadedAddons().names });
      });
      return;
    case 'circles-request': {
      const { id, request } = message;
      handleCircles(request).then(
        (result) => {
          const extra = !result ? {} : 'code' in result ? { invite: result } : { secrets: result };
          post({ type: 'circles-reply', id, ok: true, ...extra });
        },
        (err: unknown) => post({ type: 'circles-reply', id, ok: false, error: errorMessage(err) })
      );
      return;
    }
    case 'shared-request':
      void runSharedCall(message);
      return;
    case 'shared-cancel':
      sharedCalls.get(message.id)?.abort();
      return;
    case 'signal-send':
      try {
        circles?.sendSignal(message.key, message.topic, message.payload, message.to);
      } catch (err) {
        // Sent just as this Circle closed, or bad input main didn't catch.
        log('signal not sent', { error: errorMessage(err) });
      }
      return;
    case 'signal-topics':
      circles?.setSignalTopics(message.topics);
      return;
    case 'stop':
      void stop();
      return;
  }
});
