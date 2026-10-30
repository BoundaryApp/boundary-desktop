import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { persistDebugLog } from '../../persistDebugLog';
import { getSlotLlmConnection } from '../onboarding/OpenAiOnboardingStore';
import { setAwayBlocker } from './awayMode';
import { diag, short } from './circlesDiagnostics';
import { broadcast } from '../windows';
import type {
  CircleProviderSettings,
  CircleRole,
  CircleSharing,
  CirclesResult,
  CirclesSnapshot,
  CirclesState,
} from '../../../shared/types/circles';
import type { PeerModelRef } from '../../../shared/types/inferenceChain';
import { stopUtilityProcess } from '../stopUtilityProcess';
import {
  forgetCircle,
  getCircleSharing,
  getCirclesDisplayName,
  getProviderSettings,
  hasCircles,
  listCircleSecrets,
  loadCircleSeeds,
  saveCircleSecrets,
  setCircleSharing,
  setCirclesDisplayName,
  setProviderSettings as storeProviderSettings,
} from './circlesStore';
import { NETWORK_ENTRY } from './networkEntry';
import type {
  CircleSecrets,
  CirclesRequest,
  MainToNetwork,
  NetworkToMain,
  SharedModelCall,
} from './networkMessages';

/**
 * Main's side of Circles (ADR 0032 §1): it owns the user's keys and choices and runs the network
 * utilityProcess, which it starts when Circles are first used, or at launch for a user who
 * belongs to any. The renderer sees `CirclesState`, pushed on `circles:state`.
 */

const STOP_TIMEOUT_MS = 5_000;
/** Invites last a week unless the admin picks otherwise. */
const DEFAULT_INVITE_MS = 7 * 24 * 60 * 60_000;

type Reply = Extract<NetworkToMain, { type: 'circles-reply' }>;

let child: UtilityProcess | null = null;
let starting: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, (reply: Reply) => void>();

/** Shared-model calls waiting on the network process, by id. */
interface SharedCall {
  head(response: Response): void;
  fail(error: Error): void;
  /** Set once the head arrives. */
  body: ReadableStreamDefaultController<Uint8Array> | null;
  /** For diagnostics. */
  sentAt: number;
  bytes: number;
  provider: string;
}
const sharedCalls = new Map<number, SharedCall>();
const emptySnapshot: CirclesSnapshot = { identity: '', circles: [] };
let state: CirclesState = {
  status: 'stopped',
  displayName: getCirclesDisplayName(),
  snapshot: emptySnapshot,
  providers: getProviderSettings(),
  sharing: getCircleSharing(),
};

function setState(next: Partial<CirclesState>): void {
  state = { ...state, ...next };
  broadcast('circles:state', state);
}

export function getCirclesState(): CirclesState {
  return state;
}

function post(target: UtilityProcess, message: MainToNetwork): void {
  target.postMessage(message);
}

/** Start the network process if it isn't running. Resolves once it has opened the user's Circles. */
export function ensureCirclesStarted(): Promise<void> {
  if (child && state.status === 'running') return Promise.resolve();
  starting ??= start().finally(() => {
    starting = null;
  });
  return starting;
}

async function start(): Promise<void> {
  if (!state.displayName) throw new Error('Choose the name other members will see first.');
  setState({ status: 'starting', error: undefined });
  let seeds: Awaited<ReturnType<typeof loadCircleSeeds>>;
  let circles: CircleSecrets[];
  try {
    seeds = await loadCircleSeeds();
    circles = await listCircleSecrets();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState({ status: 'failed', error: message });
    throw error;
  }

  const proc = utilityProcess.fork(NETWORK_ENTRY, [], { serviceName: 'Boundary Circles' });
  child = proc;
  persistDebugLog('circles', 'network process forked', { pid: proc.pid ?? null, circles: circles.length });
  const forkedAt = Date.now();
  diag('main.net-forked', { pid: proc.pid ?? null, circles: circles.length, sharing: sharingSummary() });

  await new Promise<void>((resolve, reject) => {
    proc.on('message', (message: NetworkToMain) => {
      switch (message.type) {
        case 'circles-ready':
          diag('main.net-ready', { ms: Date.now() - forkedAt, identity: short(message.snapshot.identity) });
          setState({ status: 'running', snapshot: message.snapshot });
          resolve();
          syncSharing().catch((error: unknown) => {
            persistDebugLog('circles', 'sharing sync failed', { error: error instanceof Error ? error.message : String(error) });
          });
          return;
        case 'circles-snapshot':
          setState({ snapshot: message.snapshot });
          return;
        case 'circles-reply':
          pending.get(message.id)?.(message);
          pending.delete(message.id);
          return;
        case 'start-failed':
          persistDebugLog('circles', 'network process failed to start', { error: message.error, addons: message.addons });
          diag('main.net-start-failed', { error: message.error, addons: message.addons });
          setState({ status: 'failed', error: 'Circles couldn’t start. The debug log has the details.' });
          reject(new Error(message.error));
          return;
        case 'log':
          persistDebugLog('circles', message.message, message.data ?? {});
          return;
        case 'diag':
          diag(message.event, message.data, 'net', message.at);
          return;
        case 'shared-head':
        case 'shared-chunk':
        case 'shared-end':
          onSharedMessage(message);
          return;
        case 'addons':
        case 'stopped':
          return;
      }
    });
    proc.once('exit', (code) => {
      if (child === proc) child = null;
      for (const answer of pending.values()) answer({ type: 'circles-reply', id: 0, ok: false, error: 'Circles stopped.' });
      pending.clear();
      failSharedCalls(new Error('Circles stopped.'));
      setAwayBlocker(false);
      persistDebugLog('circles', 'network process exited', { code });
      diag('main.net-exit', { code, expected: state.status === 'stopped', ms: Date.now() - forkedAt });
      if (state.status !== 'stopped') setState({ status: 'failed', error: 'Circles stopped unexpectedly.' });
      reject(new Error('Circles stopped before they were ready.'));
    });
    post(proc, {
      type: 'circles-start',
      storageDir: path.join(app.getPath('userData'), 'circles'),
      identitySeed: seeds.identitySeed,
      deviceSeed: seeds.deviceSeed,
      name: state.displayName,
      circles,
    });
  });
}

function failSharedCalls(error: Error): void {
  if (sharedCalls.size) diag('main.shared-failed-all', { calls: sharedCalls.size, error: error.message });
  for (const call of sharedCalls.values()) {
    if (call.body) call.body.error(error);
    else call.fail(error);
  }
  sharedCalls.clear();
}

function onSharedMessage(message: Extract<NetworkToMain, { type: 'shared-head' | 'shared-chunk' | 'shared-end' }>): void {
  const call = sharedCalls.get(message.id);
  if (!call) return;
  if (message.type === 'shared-head') {
    if (call.body) return;
    const id = message.id;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        call.body = controller;
      },
      // The router stopped reading: the client hung up or the reply was refused.
      cancel: () => {
        if (!sharedCalls.delete(id)) return;
        diag('main.shared-cancel', { id, by: 'reader', bytes: call.bytes, ms: Date.now() - call.sentAt });
        if (child) post(child, { type: 'shared-cancel', id });
      },
    });
    const status = message.status >= 200 && message.status <= 599 ? message.status : 502;
    diag('main.shared-head', { id, provider: call.provider, status: message.status, headMs: Date.now() - call.sentAt });
    call.head(new Response(body, { status, headers: { 'Content-Type': message.contentType } }));
    return;
  }
  if (message.type === 'shared-chunk') {
    call.bytes += message.data.byteLength;
    call.body?.enqueue(new Uint8Array(message.data));
    return;
  }
  sharedCalls.delete(message.id);
  const error = message.error ? new Error(message.error) : null;
  diag('main.shared-end', {
    id: message.id,
    provider: call.provider,
    gotHead: call.body !== null,
    error: message.error ?? null,
    bytes: call.bytes,
    ms: Date.now() - call.sentAt,
  });
  if (!call.body) call.fail(error ?? new Error('The provider ended the request without an answer.'));
  else if (error) call.body.error(error);
  else call.body.close();
}

/**
 * Call a member's shared model through the network process (ADR 0034 §2), for the router.
 * Resolves at the reply's head, like `fetch`; rejects when Circles aren't running or the
 * provider can't be reached, which the router treats as unreachable (ADR 0033 §6).
 */
export function fetchSharedModel(peer: PeerModelRef, call: SharedModelCall, signal?: AbortSignal): Promise<Response> {
  const proc = child;
  if (!proc || state.status !== 'running') {
    diag('main.shared-refused', { provider: short(peer.providerId), status: state.status });
    return Promise.reject(new Error('Circles aren’t running.'));
  }
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  const id = nextId++;
  diag('main.shared-request', {
    id,
    circle: short(peer.circleId),
    provider: short(peer.providerId),
    path: call.path,
    bodyBytes: Buffer.byteLength(call.body ?? ''),
    inFlight: sharedCalls.size,
  });
  return new Promise<Response>((resolve, reject) => {
    const entry: SharedCall = { head: resolve, fail: reject, body: null, sentAt: Date.now(), bytes: 0, provider: short(peer.providerId)! };
    sharedCalls.set(id, entry);
    signal?.addEventListener(
      'abort',
      () => {
        if (!sharedCalls.delete(id)) return;
        diag('main.shared-cancel', { id, by: 'abort', afterHead: entry.body !== null, bytes: entry.bytes, ms: Date.now() - entry.sentAt });
        if (child) post(child, { type: 'shared-cancel', id });
        const error = new Error('cancelled');
        if (entry.body) entry.body.error(error);
        else reject(error);
      },
      { once: true }
    );
    post(proc, { type: 'shared-request', id, key: peer.circleId, provider: peer.providerId, request: call });
  });
}

const MAX_SHARED_MODELS = 32;

async function requestOrThrow(body: CirclesRequest): Promise<void> {
  const reply = await request(body);
  if (reply.ok === false) throw new Error(reply.error);
}

/** Bring the network process in line with the stored sharing settings (ADR 0034 §1–2, §4). */
async function syncSharing(): Promise<void> {
  if (!child || state.status !== 'running') {
    setAwayBlocker(false);
    return;
  }
  const { models, circles, paused, away } = state.sharing;
  const me = state.snapshot.identity;
  const sharingAny = models.length > 0 && state.snapshot.circles.some((circle) => circles.includes(circle.key));
  // Upstream first, so a member who sees the new offer can use it straight away.
  const local = sharingAny ? await getSlotLlmConnection('local') : null;
  diag('main.sharing-sync', { ...sharingSummary(), sharingAny, localConnected: Boolean(local) });
  await requestOrThrow({
    op: 'share-upstream',
    upstream: local ? { baseUrl: local.endpointUrl, ...(local.apiKey ? { apiKey: local.apiKey } : {}) } : null,
  });
  for (const circle of state.snapshot.circles) {
    const mine = circle.offers.find((offer) => offer.identity === me);
    const wanted = models.length > 0 && circles.includes(circle.key);
    if (!wanted) {
      if (mine) await requestOrThrow({ op: 'withdraw-offer', key: circle.key });
      continue;
    }
    const offer = { models, available: !paused, away };
    const same =
      mine &&
      mine.available === offer.available &&
      mine.away === offer.away &&
      JSON.stringify(mine.models) === JSON.stringify(offer.models);
    if (!same) await requestOrThrow({ op: 'publish-offer', key: circle.key, offer });
  }
  setAwayBlocker(sharingAny && away && !paused);
}

/**
 * Choose what to share and with which Circles. Offers go out at once while Circles run, and
 * when they next start otherwise.
 */
export async function setCircleSharingSettings(input: CircleSharing): Promise<CirclesResult> {
  const models = Array.isArray(input.models) ? input.models : [];
  if (models.length > MAX_SHARED_MODELS) return fail(new Error(`Share at most ${MAX_SHARED_MODELS} models.`));
  const seen = new Set<string>();
  const cleaned = [];
  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id || id.length > 200 || seen.has(id)) return fail(new Error('Each shared model needs its own id.'));
    seen.add(id);
    const contextLength = Number.isInteger(model.contextLength) && model.contextLength! > 0 ? model.contextLength : undefined;
    cleaned.push({ id, tools: model.tools !== false, ...(contextLength ? { contextLength } : {}) });
  }
  const sharing: CircleSharing = {
    models: cleaned,
    circles: [...new Set((Array.isArray(input.circles) ? input.circles : []).filter((key) => /^[0-9a-f]{64}$/.test(key)))],
    paused: input.paused === true,
    away: input.away === true,
  };
  setCircleSharing(sharing);
  setState({ sharing });
  try {
    await syncSharing();
  } catch (error) {
    persistDebugLog('circles', 'sharing sync failed', { error: error instanceof Error ? error.message : String(error) });
    return fail(new Error('Saved, but the offer couldn’t be published. It goes out when Circles next connect.'));
  }
  return { success: true, state };
}

/** Set what the user accepts from one provider; the next send plans with it (ADR 0033 §9). */
export function setProviderSettings(identity: string, settings: CircleProviderSettings): CirclesResult {
  if (!/^[0-9a-f]{64}$/.test(identity)) return fail(new Error('That isn’t a member’s identity.'));
  if (identity === state.snapshot.identity) return fail(new Error('Your own models need no settings.'));
  diag('main.provider-settings', { provider: short(identity), private: settings.private === true, trusted: settings.trusted === true });
  storeProviderSettings(identity, { private: settings.private === true, trusted: settings.trusted === true });
  setState({ providers: getProviderSettings() });
  return { success: true, state };
}

/** What the chain resolver needs to know about Circles now (ADR 0033 §10, ADR 0034 §3). */
export function sharedModelFacts(): {
  circleJoined(circleId: string): boolean;
  peerOffer(peer: PeerModelRef): Record<string, { contextLength?: number }> | null;
  providerPrivate(providerId: string): boolean;
  providerTrusted(providerId: string): boolean;
} {
  const circles = state.snapshot.circles;
  const providers = state.providers;
  return {
    providerPrivate: (providerId) => providers[providerId]?.private === true,
    providerTrusted: (providerId) => providers[providerId]?.trusted === true,
    circleJoined: (circleId) => circles.some((circle) => circle.key === circleId),
    peerOffer: (peer) => {
      const offer = circles
        .find((circle) => circle.key === peer.circleId)
        ?.offers.find((candidate) => candidate.identity === peer.providerId);
      // A paused offer can't serve, so it counts as withdrawn until the provider resumes.
      if (!offer || !offer.available) return null;
      return Object.fromEntries(
        offer.models.map((model) => [model.id, model.contextLength ? { contextLength: model.contextLength } : {}])
      );
    },
  };
}

/** The names a transcript shows for a shared model, or null once the Circle or member is gone. */
export function sharedProviderNames(peer: PeerModelRef): { person: string; circle: string } | null {
  const circle = state.snapshot.circles.find((candidate) => candidate.key === peer.circleId);
  const member = circle?.members.find((candidate) => candidate.identity === peer.providerId);
  return circle && member ? { person: member.name, circle: circle.name } : null;
}

/** At launch: start only for a user who already belongs to a Circle. */
export function startCirclesIfMember(): void {
  if (!hasCircles()) return;
  ensureCirclesStarted().catch((error: unknown) => {
    persistDebugLog('circles', 'launch start failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

export async function stopCircles(): Promise<void> {
  const proc = child;
  setAwayBlocker(false);
  if (!proc) return;
  child = null;
  setState({ status: 'stopped' });
  await stopUtilityProcess(proc, () => post(proc, { type: 'stop' }), STOP_TIMEOUT_MS);
}

async function request(body: CirclesRequest): Promise<Reply> {
  await ensureCirclesStarted();
  const proc = child;
  if (!proc) return { type: 'circles-reply', id: 0, ok: false, error: 'Circles aren’t running.' };
  const id = nextId++;
  const sent = Date.now();
  return new Promise<Reply>((resolve) => {
    pending.set(id, (reply) => {
      // The op and its outcome only: requests carry invite codes, names and offers.
      diag('main.request', { op: body.op, ok: reply.ok, error: reply.ok === false ? reply.error : null, ms: Date.now() - sent });
      resolve(reply);
    });
    post(proc, { type: 'circles-request', id, request: body });
  });
}

function sharingSummary(): Record<string, unknown> {
  const { models, circles, paused, away } = state.sharing;
  return { models: models.map((model) => model.id), circles: circles.map(short), paused, away };
}

function fail(error: unknown): CirclesResult<never> {
  return { success: false, error: error instanceof Error ? error.message : String(error), state };
}

/** Run a request and answer with the state after it, or its error. */
async function run<T extends object = object>(
  body: CirclesRequest,
  after?: (reply: Extract<Reply, { ok: true }>) => Promise<T> | T
): Promise<CirclesResult<T>> {
  try {
    const reply = await request(body);
    // `=== false`, not `!`: without strictNullChecks only the literal compare narrows.
    if (reply.ok === false) return { success: false, error: reply.error, state };
    const extra = after ? await after(reply) : ({} as T);
    return { success: true, state, ...extra };
  } catch (error) {
    return fail(error);
  }
}

export async function setDisplayName(name: string): Promise<CirclesResult> {
  const trimmed = name.trim();
  if (!trimmed) return fail(new Error('Enter a name.'));
  if (trimmed.length > 80) return fail(new Error('That name is too long.'));
  setCirclesDisplayName(trimmed);
  setState({ displayName: trimmed });
  // Only intros made from now carry it; members already in a Circle keep the name they joined with.
  if (child) await request({ op: 'set-name', name: trimmed }).catch((): undefined => undefined);
  return { success: true, state };
}

export function createCircle(name: string): Promise<CirclesResult<{ key: string }>> {
  return run({ op: 'create', name }, async (reply) => {
    await saveCircleSecrets(reply.secrets!);
    return { key: reply.secrets!.key! };
  });
}

export function joinCircle(code: string): Promise<CirclesResult<{ key: string }>> {
  return run({ op: 'join', code }, async (reply) => {
    await saveCircleSecrets(reply.secrets!);
    return { key: reply.secrets!.key! };
  });
}

export function createCircleInvite(
  key: string,
  expiresInMs = DEFAULT_INVITE_MS
): Promise<CirclesResult<{ invite: { id: string; code: string; expires: number } }>> {
  return run({ op: 'invite', key, expiresAt: Date.now() + expiresInMs }, (reply) => ({ invite: reply.invite! }));
}

export function revokeCircleInvite(key: string, inviteId: string): Promise<CirclesResult> {
  return run({ op: 'revoke-invite', key, inviteId });
}

export function setCircleRole(key: string, identity: string, role: CircleRole): Promise<CirclesResult> {
  return run({ op: 'set-role', key, identity, role });
}

export function removeCircleMember(key: string, identity: string): Promise<CirclesResult> {
  return run({ op: 'remove-member', key, identity });
}

export function leaveCircle(key: string): Promise<CirclesResult> {
  return run({ op: 'leave', key }, (): object => {
    forgetCircle(key);
    return {};
  });
}
