import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { openInvitesNamed, isOpenInvite } from '../../../shared/circleInvites';
import { addUsage, localDay } from '../../../shared/circleUsage';
import { persistDebugLog } from '../../persistDebugLog';
import { getSlotLlmConnection } from '../onboarding/OpenAiOnboardingStore';
import { setAwayBlocker } from './awayMode';
import { isMessageId, isRecordName, type CircleMessageShared, type CircleRecordScope } from './circleOps';
import { encodeSignal, isSignalTopic, type CircleSignal } from './circleSignals';
import { diag, short } from './circlesDiagnostics';
import { showWindowNotification } from '../notifications';
import { broadcast } from '../windows';
import type {
  CircleChannel,
  CircleChatUpdate,
  CircleCreatedInvite,
  CircleLimit,
  CircleLimits,
  CircleMessage,
  CirclePublicAddress,
  CircleMessageRef,
  CircleProviderSettings,
  CircleReadPosition,
  CircleRole,
  CircleSharing,
  CirclesResult,
  CirclesSnapshot,
  CirclesState,
  DirectMessage,
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
  markCircleLeaving,
  saveCircleSecrets,
  wipeOutdatedCircles,
  setCircleSharing,
  setCirclesDisplayName,
  setProviderSettings as storeProviderSettings,
  getInviteLabels,
  setInviteLabels,
  forgetInviteCode,
  getInviteCodeIds,
  listInviteCodeIds,
  pruneInviteCodes,
  readInviteCode,
  saveInviteCode,
  getNotifyPrefs,
  getReadPositions,
  getServedUsage,
  getUsedUsage,
  setReadPosition,
  setServedUsage,
  setUsedUsage,
  getServedServiceUsage,
  setServedServiceUsage,
  loadServiceGrants,
  saveServiceGrants,
} from './circlesStore';
import { keptMentions } from '../../../shared/circleMentions';
import { NETWORK_ENTRY } from './networkEntry';
import { createCircleNotifier, type CircleMessageChange, type Viewing } from './circleNotifier';
import { circleNotifierDeps } from './circleNotifications';
import { SERVICES_APP } from '../../../shared/serviceOffers';
import { mintMemberKeys, revokeMemberKeys, TwentyKeyError, type TwentyKeyDeps } from '../addons/twentyMemberKeys';
import { twentyPort } from '../addons/twentySignIn';
import { tryResolveAssistantRoot } from '../assistant/resolveAssistantRoot';
import { createSharedServices, localServiceUpstream } from './sharedServices';
import type {
  CallContext,
  CallTunnelAction,
  CallTunnelReply,
  CircleSecrets,
  CirclesRequest,
  FolderReply,
  FolderRequest,
  MainToNetwork,
  CircleRecordChange,
  CircleRecordEntry,
  NetworkToMain,
  SharedModelCall,
  ServiceCall,
} from './networkMessages';
import { captureStderr } from './stderrTail';
import { UsageTail } from './usageTail';
import { APP_NAME } from '../../../shared/buildIdentity';
import { slugify } from '../../../shared/utils/slug';

/**
 * Main's side of Circles (ADR 0032 §1): it owns the user's keys and choices and runs the network
 * utilityProcess, which it starts when Circles are first used, or at launch for a user who
 * belongs to any. The renderer sees `CirclesState`, pushed on `circles:state`.
 */

const STOP_TIMEOUT_MS = 5_000;
/** Invites last a week unless the admin picks otherwise. */
const DEFAULT_INVITE_MS = 7 * 24 * 60 * 60_000;
/** The first 3 characters of a code are constant and its end repeats, so this leaves 6 that vary. */
const INVITE_HINT_LENGTH = 9;

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
  providerId: string;
  /** The provider answered with a reply, so this call counts as used. */
  served: boolean;
  tail: UsageTail;
  /** A shared model's call counts toward the member's usage; a shared service's doesn't yet. */
  counts: boolean;
}
const sharedCalls = new Map<number, SharedCall>();

type CircleSignalHandler = (signal: { circleKey: string; fromIdentity: string; fromDevice: string; payload: unknown }) => void;
const signalHandlers = new Map<string, Set<CircleSignalHandler>>();
type CircleRecordHandler = (change: CircleRecordChange) => void;
const folderChangeHandlers = new Set<(key: string) => void>();
const readyHandlers = new Set<() => void>();
const snapshotHandlers = new Set<(snapshot: CirclesSnapshot) => void>();
const removedHandlers = new Set<(key: string) => void>();
const leavingHandlers = new Set<(key: string) => void>();
const recordHandlers = new Map<string, Set<CircleRecordHandler>>();

export type { CircleMessageChange } from './circleNotifier';
const messageHandlers = new Set<(message: CircleMessage) => void>();
/** Present while the network process runs; turns new messages into notifications. */
let notifier: ReturnType<typeof createCircleNotifier> | null = null;
let stopNotifier: (() => void)[] = [];
/** What the renderer last said it shows; kept across network restarts so a new notifier starts with it. */
let viewing: Viewing | null = null;

function stopNotifying(): void {
  for (const stop of stopNotifier) stop();
  stopNotifier = [];
  notifier?.dispose();
  notifier = null;
}
const messageChangeHandlers = new Set<(change: CircleMessageChange) => void>();
/** Messages a read returns when the caller doesn't say. */
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
/** The waiting join was cancelled, so its failure isn't one to show. */
let joinCancelled = false;
/** Whether the secrets saved at admission reached the store. */
let pairedSave: Promise<boolean> | null = null;
const emptySnapshot: CirclesSnapshot = { identity: '', circles: [] };
let state: CirclesState = {
  status: 'stopped',
  displayName: getCirclesDisplayName(),
  snapshot: emptySnapshot,
  providers: getProviderSettings(),
  sharing: getCircleSharing(),
  inviteLabels: getInviteLabels(),
  inviteCodeIds: getInviteCodeIds(),
  join: null,
  finishingJoin: null,
  served: getServedUsage(),
  serving: null,
  used: getUsedUsage(),
};

/** Reaches this Mac's Twenty as its owner, for members' keys. */
function twentyKeyDeps(): TwentyKeyDeps {
  const { root } = tryResolveAssistantRoot();
  if (!root) throw new TwentyKeyError('no-login', 'The agent stack isn’t on this Mac.');
  return { root, port: twentyPort(root) };
}

/**
 * The services this user shares with their Circles (ADR 0048). Members' keys stay in main,
 * encrypted, and in the network process's memory while it runs.
 */
const sharedServices = createSharedServices({
  load: loadServiceGrants,
  save: saveServiceGrants,
  mintKeys: (name, level) => mintMemberKeys(twentyKeyDeps(), name, level),
  revokeKeys: (ids) => revokeMemberKeys(twentyKeyDeps(), ids),
  upstreamFor: (service) => {
    const { root } = tryResolveAssistantRoot();
    return localServiceUpstream(service, root ? twentyPort(root) : null);
  },
  setOffer: (circle, service, offer) =>
    requestOrThrow({ op: 'record-set', key: circle, app: SERVICES_APP, scope: 'member', record: service, value: offer }),
  deleteOffer: (circle, service) =>
    requestOrThrow({ op: 'record-del', key: circle, app: SERVICES_APP, scope: 'member', record: service }),
  push: async (sharing) => {
    if (child && state.status === 'running') await requestOrThrow({ op: 'service-sharing', sharing });
  },
  log: (message, data) => persistDebugLog('circles', message, data ?? {}),
});

/** The provider's side of shared services, for the share sheet and the shared rows. */
export function getSharedServices(): typeof sharedServices {
  return sharedServices;
}

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

const circlesStorageDir = (): string => path.join(app.getPath('userData'), 'circles');

async function start(): Promise<void> {
  if (!state.displayName) throw new Error('Choose the name other members will see first.');
  setState({ status: 'starting', error: undefined });
  let seeds: Awaited<ReturnType<typeof loadCircleSeeds>>;
  let circles: CircleSecrets[];
  try {
    wipeOutdatedCircles(circlesStorageDir());
    setState({ sharing: getCircleSharing(), inviteCodeIds: getInviteCodeIds() });
    seeds = await loadCircleSeeds();
    circles = await listCircleSecrets();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState({ status: 'failed', error: message });
    throw error;
  }

  // stderr is piped so an uncaught error or native crash message reaches the debug log.
  const proc = utilityProcess.fork(NETWORK_ENTRY, [], { serviceName: `${APP_NAME} Circles`, stdio: ['ignore', 'inherit', 'pipe'] });
  const stderr = captureStderr(proc.stderr);
  child = proc;
  stopNotifying();
  notifier = createCircleNotifier(
    circleNotifierDeps({ snapshot: () => state.snapshot, listChannels: listCircleChannels }),
    viewing
  );
  stopNotifier = [onCircleMessage(notifier.onMessage), onCircleMessageChange(notifier.onChange)];
  persistDebugLog('circles', 'network process forked', { pid: proc.pid ?? null, circles: circles.length });
  const forkedAt = Date.now();
  diag('main.net-forked', { pid: proc.pid ?? null, circles: circles.length, sharing: sharingSummary() });

  await new Promise<void>((resolve, reject) => {
    proc.on('message', (message: NetworkToMain) => {
      switch (message.type) {
        case 'circles-ready':
          diag('main.net-ready', { ms: Date.now() - forkedAt, identity: short(message.snapshot.identity) });
          setState({ status: 'running', snapshot: message.snapshot, inviteCodeIds: pruneInviteCodes(message.snapshot.circles) });
          postSignalTopics();
          postRecordApps();
          resolve();
          for (const handler of readyHandlers) handler();
          syncSharing().catch((error: unknown) => {
            persistDebugLog('circles', 'sharing sync failed', { error: error instanceof Error ? error.message : String(error) });
          });
          sharedServices.sync().catch((error: unknown) => {
            persistDebugLog('circles', 'shared services sync failed', { error: error instanceof Error ? error.name : typeof error });
          });
          return;
        case 'circles-snapshot':
          onSnapshot(message.snapshot);
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
        case 'circle-paired':
          onCirclePaired(message.secrets);
          return;
        case 'circle-removed':
          forgetCircle(message.key);
          for (const handler of removedHandlers) handler(message.key);
          setState({ inviteCodeIds: getInviteCodeIds() });
          break;
        case 'folder-changed':
          for (const handler of folderChangeHandlers) handler(message.key);
          return;
        case 'member-left':
          showWindowNotification({ title: message.circle, body: `${message.name} left the Circle.` });
          return;
        case 'service-usage':
          setServedServiceUsage(message.served);
          return;
        case 'share-usage':
          if (message.served) setServedUsage(message.served);
          setState({ served: message.served, serving: message.serving });
          return;
        case 'signal-received':
          onSignalReceived(message.signal);
          return;
        case 'record-changed':
          onRecordChanged(message.change);
          return;
        case 'chat-update':
          onChatUpdate(message.update);
          return;
        case 'addons':
        case 'stopped':
          return;
      }
    });
    proc.once('exit', (code) => {
      if (child === proc) {
        child = null;
        stopNotifying();
      }
      for (const answer of pending.values()) answer({ type: 'circles-reply', id: 0, ok: false, error: 'Circles stopped.' });
      pending.clear();
      failSharedCalls(new Error('Circles stopped.'));
      setAwayBlocker(false);
      setAwayBlocker(false, 'services');
      setState({ serving: null });
      persistDebugLog('circles', 'network process exited', { code });
      const expected = state.status === 'stopped';
      diag('main.net-exit', { code, expected, ms: Date.now() - forkedAt });
      if (!expected) {
        void stderr.settled().then(({ bytes, tail }) => {
          if (bytes > 0) persistDebugLog('circles', 'network process stderr', { code, bytes, tail });
        });
      }
      if (state.status !== 'stopped') setState({ status: 'failed', error: 'Circles stopped unexpectedly.' });
      reject(new Error('Circles stopped before they were ready.'));
    });
    post(proc, {
      type: 'circles-start',
      storageDir: circlesStorageDir(),
      identitySeed: seeds.identitySeed,
      deviceSeed: seeds.deviceSeed,
      name: state.displayName,
      circles,
      usage: state.served,
      serviceUsage: getServedServiceUsage(),
    });
  });
}

function onSnapshot(snapshot: CirclesSnapshot): void {
  for (const handler of snapshotHandlers) handler(snapshot);
  const caughtUp = snapshot.circles.some(
    (circle) => circle.writable && state.snapshot.circles.find((before) => before.key === circle.key)?.writable === false
  );
  setState({ snapshot, inviteCodeIds: pruneInviteCodes(snapshot.circles) });
  if (!caughtUp) return;
  syncSharing().catch((error: unknown) => {
    persistDebugLog('circles', 'sharing sync failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

/** Admitted: there's nothing left to cancel, so the join's state goes and the Circle takes over. */
function onCirclePaired(secrets: CircleSecrets): void {
  pairedSave = saveCircleSecrets(secrets).then(
    () => true,
    (error: unknown) => {
      persistDebugLog('circles', 'saving a joined Circle failed', { error: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  );
  setState({ join: null, finishingJoin: secrets.key ?? null });
}

/** The member's own count of a call the provider answered (ADR 0034 §5). */
function countUsed(call: SharedCall): void {
  if (!call.served || !call.counts) return;
  const used = addUsage(state.used, call.providerId, localDay(new Date()), { requests: 1, tokens: call.tail.tokens() ?? 0 });
  setUsedUsage(used);
  setState({ used });
}

function failSharedCalls(error: Error): void {
  if (sharedCalls.size) diag('main.shared-failed-all', { calls: sharedCalls.size, error: error.message });
  for (const call of sharedCalls.values()) {
    countUsed(call);
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
        countUsed(call);
        diag('main.shared-cancel', { id, by: 'reader', bytes: call.bytes, ms: Date.now() - call.sentAt });
        if (child) post(child, { type: 'shared-cancel', id });
      },
    });
    const status = message.status >= 200 && message.status <= 599 ? message.status : 502;
    call.served = status >= 200 && status < 300;
    diag('main.shared-head', { id, provider: call.provider, status: message.status, headMs: Date.now() - call.sentAt });
    call.head(new Response(body, { status, headers: { 'Content-Type': message.contentType } }));
    return;
  }
  if (message.type === 'shared-chunk') {
    call.bytes += message.data.byteLength;
    call.tail.push(message.data);
    call.body?.enqueue(new Uint8Array(message.data));
    return;
  }
  sharedCalls.delete(message.id);
  countUsed(call);
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
  return startSharedCall(
    peer,
    (id) => ({ type: 'shared-request', id, key: peer.circleId, provider: peer.providerId, request: call }),
    { path: call.path, bodyBytes: Buffer.byteLength(call.body ?? ''), counts: true },
    signal
  );
}

/**
 * Call a service a member shares through the network process (ADR 0048 §3), for this Mac's
 * listener. Resolves at the reply's head, like `fetch`; rejects when Circles aren't running or the
 * provider can't be reached, which the listener reports as the provider being offline (§11).
 */
export function fetchSharedService(peer: SharedServiceRef, call: ServiceCall, signal?: AbortSignal): Promise<Response> {
  return startSharedCall(
    peer,
    (id) => ({ type: 'service-request', id, key: peer.circleId, provider: peer.providerId, request: call }),
    { path: call.path, bodyBytes: Buffer.byteLength(call.body ?? ''), service: call.service, level: call.level, counts: false },
    signal
  );
}

/** Which member's service a call goes to. */
export interface SharedServiceRef {
  circleId: string;
  providerId: string;
}

function startSharedCall(
  peer: SharedServiceRef,
  message: (id: number) => MainToNetwork,
  meta: { path: string; bodyBytes: number; counts: boolean; service?: string; level?: string },
  signal?: AbortSignal
): Promise<Response> {
  const proc = child;
  if (!proc || state.status !== 'running') {
    diag('main.shared-refused', { provider: short(peer.providerId), status: state.status });
    return Promise.reject(new Error('Circles aren’t running.'));
  }
  if (signal?.aborted) return Promise.reject(new Error('cancelled'));
  const id = nextId++;
  const { counts, ...described } = meta;
  diag('main.shared-request', {
    id,
    circle: short(peer.circleId),
    provider: short(peer.providerId),
    ...described,
    inFlight: sharedCalls.size,
  });
  return new Promise<Response>((resolve, reject) => {
    const entry: SharedCall = {
      head: resolve,
      fail: reject,
      body: null,
      sentAt: Date.now(),
      bytes: 0,
      provider: short(peer.providerId)!,
      providerId: peer.providerId,
      served: false,
      tail: new UsageTail(),
      counts,
    };
    sharedCalls.set(id, entry);
    signal?.addEventListener(
      'abort',
      () => {
        if (!sharedCalls.delete(id)) return;
        countUsed(entry);
        diag('main.shared-cancel', { id, by: 'abort', afterHead: entry.body !== null, bytes: entry.bytes, ms: Date.now() - entry.sentAt });
        if (child) post(child, { type: 'shared-cancel', id });
        const error = new Error('cancelled');
        if (entry.body) entry.body.error(error);
        else reject(error);
      },
      { once: true }
    );
    post(proc, message(id));
  });
}

function postSignalTopics(): void {
  if (child && state.status === 'running') post(child, { type: 'signal-topics', topics: [...signalHandlers.keys()] });
}

function onSignalReceived(signal: CircleSignal): void {
  for (const handler of signalHandlers.get(signal.topic) ?? []) {
    try {
      handler({ circleKey: signal.circle, fromIdentity: signal.from, fromDevice: signal.device, payload: signal.payload });
    } catch (error) {
      // The topic only: an error from a handler can quote the payload.
      persistDebugLog('circles', 'signal handler failed', { topic: signal.topic });
      diag('main.signal-handler-failed', { topic: signal.topic, error: error instanceof Error ? error.name : typeof error });
    }
  }
}

/**
 * Listen to peer signals on a topic, in any Circle. The network process has already checked that
 * the sender is a current member of `circleKey`; the payload is otherwise untrusted. Returns a
 * function that stops listening.
 */
export function onCircleSignal(topic: string, handler: CircleSignalHandler): () => void {
  if (!isSignalTopic(topic)) throw new Error('That isn’t a signal topic.');
  const handlers = signalHandlers.get(topic) ?? new Set<CircleSignalHandler>();
  signalHandlers.set(topic, handlers);
  handlers.add(handler);
  postSignalTopics();
  return () => {
    handlers.delete(handler);
    if (handlers.size > 0 || signalHandlers.get(topic) !== handlers) return;
    signalHandlers.delete(topic);
    postSignalTopics();
  };
}

/**
 * Send a short message to the members of a Circle who are connected, or to one of them. Nothing
 * keeps it, and a peer over its rate limit misses it. Returns false when Circles aren't running;
 * throws on a bad topic or a payload over the limit.
 */
export function sendCircleSignal(circleKey: string, topic: string, payload: unknown, toIdentity?: string): boolean {
  encodeSignal({ circle: circleKey, topic, payload });
  if (!child || state.status !== 'running') return false;
  post(child, { type: 'signal-send', key: circleKey, topic, payload, ...(toIdentity ? { to: toIdentity } : {}) });
  return true;
}

const MAX_SHARED_MODELS = 32;

function cleanLimit(input: CircleLimit | undefined): CircleLimit {
  const limit: CircleLimit = {};
  for (const field of ['requestsPerDay', 'tokensPerDay', 'concurrent'] as const) {
    const value = input?.[field];
    if (Number.isSafeInteger(value) && value! > 0) limit[field] = value;
  }
  return limit;
}

function cleanLimits(input: CircleLimits): CircleLimits {
  const members = Object.entries(input.members ?? {}).filter(([identity]) => /^[0-9a-f]{64}$/.test(identity));
  return {
    everyone: cleanLimit(input.everyone),
    members: Object.fromEntries(members.map(([identity, limit]) => [identity, cleanLimit(limit)])),
  };
}

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
  const { models, circles, paused, away, limits } = state.sharing;
  const me = state.snapshot.identity;
  const sharingAny = models.length > 0 && state.snapshot.circles.some((circle) => circles.includes(circle.key));
  // Upstream first, so a member who sees the new offer can use it straight away.
  const local = sharingAny ? await getSlotLlmConnection('local') : null;
  diag('main.sharing-sync', { ...sharingSummary(), sharingAny, localConnected: Boolean(local) });
  await requestOrThrow({
    op: 'share-upstream',
    upstream: local ? { baseUrl: local.endpointUrl, ...(local.apiKey ? { apiKey: local.apiKey } : {}) } : null,
    ...(limits ? { limits } : {}),
  });
  for (const circle of state.snapshot.circles) {
    const mine = circle.offers.find((offer) => offer.identity === me);
    // A Circle still joining can't take an offer. This runs again once it has caught up.
    if (!circle.writable) continue;
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
  const limits = input.limits ?? state.sharing.limits;
  const sharing: CircleSharing = {
    models: cleaned,
    circles: [...new Set((Array.isArray(input.circles) ? input.circles : []).filter((key) => /^[0-9a-f]{64}$/.test(key)))],
    paused: input.paused === true,
    away: input.away === true,
    ...(limits ? { limits: cleanLimits(limits) } : {}),
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
  /** Circles' answers are current; otherwise a Circle may only look left. */
  running: boolean;
  /** This user's own identity key. */
  identity: string;
  /** What the provider goes by in this Circle. */
  providerName(peer: PeerModelRef): string;
  /** Connected to this device now. */
  providerOnline(peer: PeerModelRef): boolean;
  circleJoined(circleId: string): boolean;
  peerOffer(peer: PeerModelRef): Record<string, { contextLength?: number }> | null;
  providerPrivate(providerId: string): boolean;
  providerTrusted(providerId: string): boolean;
} {
  const circles = state.snapshot.circles;
  const providers = state.providers;
  const circleOf = (peer: PeerModelRef) => circles.find((circle) => circle.key === peer.circleId);
  const offerOf = (peer: PeerModelRef) => circleOf(peer)?.offers.find((offer) => offer.identity === peer.providerId);
  return {
    running: state.status === 'running',
    identity: state.snapshot.identity,
    providerName: (peer) =>
      offerOf(peer)?.name ??
      circleOf(peer)?.members.find((member) => member.identity === peer.providerId)?.name ??
      'A member',
    providerOnline: (peer) => offerOf(peer)?.online === true,
    providerPrivate: (providerId) => providers[providerId]?.private === true,
    providerTrusted: (providerId) => providers[providerId]?.trusted === true,
    circleJoined: (circleId) => circles.some((circle) => circle.key === circleId),
    peerOffer: (peer) => {
      const offer = offerOf(peer);
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
  stopNotifying();
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

function postRecordApps(): void {
  if (child && state.status === 'running') post(child, { type: 'record-apps', apps: [...recordHandlers.keys()] });
}

function onRecordChanged(change: CircleRecordChange): void {
  for (const handler of recordHandlers.get(change.app) ?? []) {
    try {
      handler(change);
    } catch (error) {
      // The app only: an error from a handler can quote the value.
      persistDebugLog('circles', 'record handler failed', { app: change.app });
      diag('main.record-handler-failed', { app: change.app, error: error instanceof Error ? error.name : typeof error });
    }
  }
}

/**
 * Listen to one app's records in every Circle: changes, deletions and confirmations, and every
 * record of a Circle as it opens. A value is untrusted, as `apply` checks only its size. Returns a
 * function that stops listening.
 */
export function onCircleRecord(app: string, handler: CircleRecordHandler): () => void {
  if (!isRecordName(app)) throw new Error('That isn’t a record name.');
  const handlers = recordHandlers.get(app) ?? new Set<CircleRecordHandler>();
  recordHandlers.set(app, handlers);
  handlers.add(handler);
  postRecordApps();
  return () => {
    handlers.delete(handler);
    if (handlers.size > 0 || recordHandlers.get(app) !== handlers) return;
    recordHandlers.delete(app);
    postRecordApps();
  };
}

/**
 * Keep a value in a Circle for every member. `scope: 'circle'` is one value that only admins
 * write; `scope: 'member'` is this user's own value. Values are JSON, up to 16 KB. With `keep`, a
 * `member` record stays after this user leaves or is removed, until an admin deletes it.
 */
export function setCircleRecord(
  circleKey: string,
  app: string,
  scope: CircleRecordScope,
  record: string,
  value: unknown,
  { keep = false }: { keep?: boolean } = {}
): Promise<CirclesResult> {
  return run({ op: 'record-set', key: circleKey, app, scope, record, value, ...(keep ? { keep } : {}) });
}

/** With `identity`, an admin deletes a kept record of someone who is no longer a member. */
export function deleteCircleRecord(
  circleKey: string,
  app: string,
  scope: CircleRecordScope,
  record: string,
  { identity }: { identity?: string } = {}
): Promise<CirclesResult> {
  return run({ op: 'record-del', key: circleKey, app, scope, record, ...(identity ? { identity } : {}) });
}

/** This device's address as the DHT sees it, for the call check's `swarm` mode (ADR 0044). */
export function getPublicAddress(): Promise<CirclesResult<{ address: CirclePublicAddress | null }>> {
  return run({ op: 'public-address' }, (reply) => ({ address: reply.address ?? null }));
}

/** Open, read or close a call tunnel to one member, or to one of their devices when `device` is given. */
export function callTunnel(
  action: CallTunnelAction,
  circleKey: string,
  toIdentity: string,
  tunnel: number,
  device?: string
): Promise<CirclesResult<CallTunnelReply>> {
  return run({ op: 'call-tunnel', action, key: circleKey, to: toIdentity, tunnel, ...(device ? { device } : {}) }, (reply) => reply.tunnel ?? {});
}

/** The DHT's view of this network and the Circles connection to one member, for a call check result. */
export function getCallContext(circleKey: string, toIdentity: string): Promise<CirclesResult<{ context: CallContext }>> {
  return run({ op: 'call-context', key: circleKey, to: toIdentity }, (reply) => ({ context: reply.context ?? {} }));
}

/** One app's records in a Circle as this device has them now. */
export function getCircleRecords(circleKey: string, app: string): Promise<CirclesResult<{ records: CircleRecordEntry[] }>> {
  return run({ op: 'records-list', key: circleKey, app }, (reply) => ({ records: reply.records ?? [] }));
}

function callChatHandlers<T>(handlers: Set<(event: T) => void>, event: T): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (error) {
      // No message content: an error from a handler can quote it.
      diag('main.chat-handler-failed', { error: error instanceof Error ? error.name : typeof error });
    }
  }
}

function onChatUpdate(update: CircleChatUpdate): void {
  broadcast('circles:chat-event', update);
  for (const message of update.added) callChatHandlers(messageHandlers, message);
  for (const message of update.changed) callChatHandlers(messageChangeHandlers, { kind: 'changed', message });
  for (const ref of update.gone) {
    callChatHandlers(messageChangeHandlers, { kind: 'gone', circleKey: update.circleKey, channel: update.channel, ...ref });
  }
}

/**
 * New messages in any Circle, each once per launch, the first time this device sees it after its
 * Circle opened. Messages already there when a Circle opens don't fire; ones caught up after being
 * offline do. Returns a function that stops listening.
 */
export function onCircleMessage(handler: (message: CircleMessage) => void): () => void {
  messageHandlers.add(handler);
  return () => messageHandlers.delete(handler);
}

/** Edits, deletes, confirmations and messages that disappear when their order settles. */
export function onCircleMessageChange(handler: (change: CircleMessageChange) => void): () => void {
  messageChangeHandlers.add(handler);
  return () => messageChangeHandlers.delete(handler);
}

/** A Circle's channels, `general` first, with what's unread after this device's read positions. */
export function listCircleChannels(circleKey: string): Promise<CirclesResult<{ channels: CircleChannel[] }>> {
  return run({ op: 'chat-channels', key: circleKey, reads: getReadPositions(circleKey), channelMentions: getNotifyPrefs(circleKey).channelMentions }, (reply) => ({
    channels: reply.chat?.channels ?? [],
  }));
}

/** The newest messages in a channel, or those before `before`, oldest first. */
export function getCircleMessages(
  circleKey: string,
  channel: string,
  { before, limit = DEFAULT_MESSAGE_LIMIT }: { before?: CircleMessageRef; limit?: number } = {}
): Promise<CirclesResult<{ messages: CircleMessage[]; more: boolean }>> {
  const count = Math.max(1, Math.min(MAX_MESSAGE_LIMIT, Math.floor(limit) || DEFAULT_MESSAGE_LIMIT));
  return run({ op: 'chat-messages', key: circleKey, channel, ...(before ? { before } : {}), limit: count }, (reply) => ({
    messages: reply.chat?.messages ?? [],
    more: reply.chat?.more === true,
  }));
}

/** What the composer picked: people chosen from the @ list, and whether @channel was chosen. Main keeps those still in the text. */
interface ChatMentionOptions {
  picked?: { identity: string; name: string }[];
  mentionChannel?: boolean;
}

/** Post as this user. The channel counts as read up to the new message. */
export async function postCircleMessage(
  circleKey: string,
  channel: string,
  text: string,
  { shared, picked = [], mentionChannel = false, reply }: ChatMentionOptions & { shared?: CircleMessageShared; reply?: CircleMessageRef } = {}
): Promise<CirclesResult<{ id: string }>> {
  const mentions = keptMentions(text, picked, mentionChannel);
  const body = {
    op: 'chat-post' as const,
    key: circleKey,
    channel,
    text,
    ...(shared ? { shared } : {}),
    ...(mentions ? { mentions } : {}),
    ...(reply ? { reply } : {}),
  };
  const result = await run(body, (reply) => ({ id: reply.chat!.id! }));
  if (result.success === true && state.snapshot.identity) {
    setReadPosition(circleKey, channel, { author: state.snapshot.identity, id: result.id, at: Date.now(), reactionsAt: Date.now() });
  }
  return result;
}

/** One message by reference, or null when this device's view of the Circle doesn't hold it. */
export function getCircleMessage(
  circleKey: string,
  channel: string,
  ref: CircleMessageRef
): Promise<CirclesResult<{ message: CircleMessage | null }>> {
  return run({ op: 'chat-message', key: circleKey, channel, ref }, (reply) => ({ message: reply.chat?.message ?? null }));
}

export function editCircleMessage(
  circleKey: string,
  channel: string,
  id: string,
  text: string,
  { picked = [], mentionChannel = false }: ChatMentionOptions = {}
): Promise<CirclesResult> {
  const mentions = keptMentions(text, picked, mentionChannel);
  return run({ op: 'chat-edit', key: circleKey, channel, id, text, ...(mentions ? { mentions } : {}) });
}

/** The author deletes their own; an admin deletes anyone's. */
export function deleteCircleMessage(circleKey: string, channel: string, author: string, id: string): Promise<CirclesResult> {
  return run({ op: 'chat-delete', key: circleKey, channel, author, id });
}

/** Add (`on`) or take back this user's emoji reaction on a message. */
export function reactCircleMessage(circleKey: string, channel: string, ref: CircleMessageRef, emoji: string, on: boolean): Promise<CirclesResult> {
  return run({ op: 'chat-react', key: circleKey, channel, author: ref.author, id: ref.id, emoji, on });
}

/** Channels are Circle records of this app, valued `{ name }` (ADR 0042 §1). */
const CHAT_APP = 'chat';
const MAX_CHANNEL_NAME = 80;

async function channelNameProblem(circleKey: string, name: string, except?: string): Promise<string | null> {
  if (!name) return 'Enter a name.';
  if (name.length > MAX_CHANNEL_NAME) return 'That name is too long.';
  const current = await listCircleChannels(circleKey);
  if (current.success === false) return current.error;
  const taken = current.channels.some((channel) => channel.id !== except && channel.name.toLowerCase() === name.toLowerCase());
  return taken ? 'This Circle already has a channel with that name.' : null;
}

/**
 * Add a channel; admins only. Its id gets a random ending, so a name used by a removed channel
 * starts empty instead of showing that channel's history again.
 */
export async function addCircleChannel(circleKey: string, name: string): Promise<CirclesResult<{ id: string }>> {
  const trimmed = name.trim();
  const problem = await channelNameProblem(circleKey, trimmed);
  if (problem) return fail(new Error(problem));
  const slug = slugify(trimmed, { max: 48, fallback: 'channel' });
  const id = `${slug}-${randomBytes(3).toString('hex')}`;
  const result = await setCircleRecord(circleKey, CHAT_APP, 'circle', id, { name: trimmed });
  return result.success === false ? result : { ...result, id };
}

/** Rename a channel, General included; admins only. */
export async function renameCircleChannel(circleKey: string, channel: string, name: string): Promise<CirclesResult> {
  const trimmed = name.trim();
  if (!isRecordName(channel)) return fail(new Error('That isn’t a channel.'));
  const problem = await channelNameProblem(circleKey, trimmed, channel);
  if (problem) return fail(new Error(problem));
  return setCircleRecord(circleKey, CHAT_APP, 'circle', channel, { name: trimmed });
}

/** Hide a channel for everyone; its messages stay in the Circle's log. General can't go. */
export function removeCircleChannel(circleKey: string, channel: string): Promise<CirclesResult> {
  if (channel === 'general') return Promise.resolve(fail(new Error('General can’t be removed.')));
  if (!isRecordName(channel)) return Promise.resolve(fail(new Error('That isn’t a channel.')));
  return deleteCircleRecord(circleKey, CHAT_APP, 'circle', channel);
}

/** Tell the renderer when a Circle's channels may have changed, on `circles:chat-channels`. */
export function listenForChannelChanges(): () => void {
  return onCircleRecord(CHAT_APP, (change) => {
    if (change.scope === 'circle') broadcast('circles:chat-channels', { circleKey: change.circleKey });
  });
}

/** Keep the newest message read in a channel, on this device only (ADR 0042 §8). */
export function markCircleChannelRead(circleKey: string, channel: string, position: CircleReadPosition): CirclesResult {
  const { author, id, at } = position ?? ({} as CircleReadPosition);
  if (!isRecordName(channel) || typeof author !== 'string' || !isMessageId(id) || !Number.isSafeInteger(at)) {
    return fail(new Error('That isn’t a read position.'));
  }
  // reactionsAt comes from this device's clock, never from the renderer.
  setReadPosition(circleKey, channel, { author, id, at, reactionsAt: Date.now() });
  notifier?.noteRead(circleKey, channel);
  return { success: true, state };
}

/** What this device is showing, so a focused channel stays silent. Null when no channel is open. */
/** A direct message from `peer` reached this device, or changed: it may notify (ADR 0054 §10). */
export function notifyDirect(circleKey: string, peer: string, name: string, message: DirectMessage, kind: 'new' | 'change'): void {
  if (kind === 'new') notifier?.onDirect(circleKey, peer, name, message);
  else notifier?.onDirectChange(circleKey, peer, name, message);
}

export function setCircleViewing(next: Viewing | null): void {
  viewing = next;
  notifier?.setViewing(next);
}

/** How many people a Circle has: its members (agents aren't members, ADR 0042 §12). 0 when this device doesn't have it. */
export function circlePeople(circleKey: string): number {
  return state.snapshot.circles.find((circle) => circle.key === circleKey)?.members.length ?? 0;
}

/** Hear when a shared folder's view or mirror changed (ADR 0049). Returns a function that stops. */
export function onSharedFolderChange(handler: (key: string) => void): () => void {
  folderChangeHandlers.add(handler);
  return () => folderChangeHandlers.delete(handler);
}

/** Hear each time the Circles network has started and opened every Circle. Returns a function that stops. */
export function onCirclesReady(handler: () => void): () => void {
  readyHandlers.add(handler);
  return () => readyHandlers.delete(handler);
}

/** Hear each new snapshot from the network: members, roles and presence. Returns a function that stops. */
export function onCirclesSnapshot(handler: (snapshot: CirclesSnapshot) => void): () => void {
  snapshotHandlers.add(handler);
  return () => snapshotHandlers.delete(handler);
}

/**
 * Hear when this user leaves or deletes a Circle, at once rather than when an admin confirms the
 * leave. What only this device kept for the Circle can go then. Returns a function that stops.
 */
export function onCircleLeaving(handler: (key: string) => void): () => void {
  leavingHandlers.add(handler);
  return () => leavingHandlers.delete(handler);
}

/** Hear when this device left or was removed from a Circle and closed it. Returns a function that stops. */
export function onCircleRemoved(handler: (key: string) => void): () => void {
  removedHandlers.add(handler);
  return () => removedHandlers.delete(handler);
}

/** Send one shared folder request; throws with the network's error. */
export async function folderRequest(body: FolderRequest): Promise<FolderReply> {
  const reply = await request(body);
  if (reply.ok === false) throw new Error(reply.error);
  return reply.folders ?? {};
}

/** Run `work` and answer with the state after it, or its error. */
export async function circlesResult<T extends object>(work: () => Promise<T>): Promise<CirclesResult<T>> {
  try {
    return { success: true, state, ...(await work()) };
  } catch (error) {
    return fail(error);
  }
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

/** Main holds a join's state, so it outlives the screen that started it. */
export async function joinCircle(code: string): Promise<CirclesResult<{ key: string }>> {
  if (state.join?.waiting || state.finishingJoin) return fail(new Error('A join is already in progress.'));
  joinCancelled = false;
  setState({ join: { waiting: true } });
  const result = await run({ op: 'join', code }, async (reply) => {
    await saveCircleSecrets(reply.secrets!);
    return { key: reply.secrets!.key! };
  });
  if (result.success === false && state.finishingJoin) {
    // Admitted, so saying the join failed would be wrong. The secrets decide what comes next.
    const error = (await pairedSave)
      ? `This device joined, but the Circle couldn’t open. Restart ${APP_NAME} to finish joining.`
      : 'This device joined, but the keychain couldn’t keep the Circle’s key. It won’t be here after you quit.';
    setState({ finishingJoin: null, join: { waiting: false, error } });
    return { ...result, state };
  }
  setState({
    finishingJoin: null,
    join: result.success === false && !joinCancelled ? { waiting: false, error: result.error } : null,
  });
  return { ...result, state };
}

/** Stops a join that's waiting, or clears one that failed. */
export async function cancelJoin(): Promise<CirclesResult> {
  const waiting = state.join?.waiting === true;
  joinCancelled = waiting;
  setState({ join: null });
  return waiting ? run({ op: 'join-cancel' }) : { success: true, state };
}

/** Keep a new invite's code on this device. Failing costs the Show and Copy controls, not the invite. */
async function keepInviteCode(key: string, invite: { id: string; code: string; expires: number }): Promise<boolean> {
  try {
    await saveInviteCode(key, invite.id, invite.code, invite.expires);
    setState({ inviteCodeIds: getInviteCodeIds() });
    return true;
  } catch (error) {
    persistDebugLog('circles', 'keeping an invite code failed', { error: error instanceof Error ? error.name : 'unknown' });
    return false;
  }
}

/**
 * Make an invite. One named like an open invite in this Circle replaces it: the new code comes
 * first, so a failure leaves the old one working, and the old code stops working once an admin's
 * device has seen the revoke.
 */
export async function createCircleInvite(
  key: string,
  expiresInMs = DEFAULT_INVITE_MS,
  label = ''
): Promise<CirclesResult<{ invite: CircleCreatedInvite }>> {
  const name = label.trim().slice(0, 80);
  const named = openInvitesNamed(
    state.snapshot.circles.find((circle) => circle.key === key),
    state.inviteLabels,
    name
  );
  const result = await run({ op: 'invite', key, expiresAt: Date.now() + expiresInMs }, (reply) => ({
    invite: reply.invite!,
  }));
  if (result.success === false) return result;
  const kept = await keepInviteCode(key, result.invite);
  const replaced = new Set<string>();
  for (const invite of named) {
    const revoked = await revokeCircleInvite(key, invite.id);
    if (revoked.success) replaced.add(invite.id);
  }
  if (named.length) diag('main.invite-replaced', { circle: short(key), replaced: replaced.size, stillOpen: named.length - replaced.size });
  const invite = { ...result.invite, kept, stillOpen: named.length - replaced.size };
  if (!name) return { ...result, invite, state };
  // Labels of invites that are over go, so the list doesn't grow.
  const now = Date.now();
  const open = new Set(
    state.snapshot.circles.flatMap((circle) => circle.invites.filter((item) => isOpenInvite(item, now)).map((item) => item.id))
  );
  const held = Object.entries(state.inviteLabels ?? {}).filter(([id]) => open.has(id) && !replaced.has(id));
  const inviteLabels = { ...Object.fromEntries(held), [invite.id]: name };
  setInviteLabels(inviteLabels);
  setState({ inviteLabels });
  return { ...result, invite, state };
}

export function revokeCircleInvite(key: string, inviteId: string): Promise<CirclesResult> {
  return run({ op: 'revoke-invite', key, inviteId }, (): object => {
    forgetInviteCode(key, inviteId);
    setState({ inviteCodeIds: getInviteCodeIds() });
    return {};
  });
}

/** The start of each code this device keeps for a Circle, by invite id. */
export async function getCircleInviteHints(key: string): Promise<CirclesResult<{ hints: Record<string, string> }>> {
  const hints: Record<string, string> = {};
  for (const inviteId of listInviteCodeIds(key)) {
    const code = await readInviteCode(key, inviteId);
    if (code) hints[inviteId] = code.slice(0, INVITE_HINT_LENGTH);
  }
  return { success: true, state, hints };
}

export async function getCircleInviteCode(key: string, inviteId: string): Promise<CirclesResult<{ code: string }>> {
  setState({ inviteCodeIds: pruneInviteCodes(state.snapshot.circles) });
  const code = await readInviteCode(key, inviteId);
  return code ? { success: true, state, code } : fail(new Error('This Mac no longer has that code.'));
}

export function setCircleRole(key: string, identity: string, role: CircleRole): Promise<CirclesResult> {
  return run({ op: 'set-role', key, identity, role });
}

export function removeCircleMember(key: string, identity: string): Promise<CirclesResult> {
  return run({ op: 'remove-member', key, identity });
}

/** The Circle leaves the snapshot now; main keeps its secrets until an admin confirms the leave. */
export function leaveCircle(key: string): Promise<CirclesResult> {
  return run({ op: 'leave', key }, (): object => {
    markCircleLeaving(key);
    for (const handler of leavingHandlers) handler(key);
    setState({ inviteCodeIds: getInviteCodeIds() });
    return {};
  });
}

export function deleteCircle(key: string): Promise<CirclesResult> {
  return run({ op: 'delete', key }, (): object => {
    forgetCircle(key);
    for (const handler of leavingHandlers) handler(key);
    setState({ inviteCodeIds: getInviteCodeIds() });
    return {};
  });
}
