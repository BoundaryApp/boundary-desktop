import type { HermesHeldTurn } from '../../../../shared/types/hermesChat';
import { persistDebugLog } from '../../../persistDebugLog';

// Turn admission for local model servers (workload scheduling plan, Phase 1a). A local server
// answers only as many requests at once as it has parallel slots; the rest wait in its queue,
// where Hermes's stale timer runs and the waiting request evicts the running chat's prompt
// cache. So a turn on a local model waits here instead, before `prompt.submit`, until the
// server has a free slot. Servers are keyed by origin: two models on one server share its slots.
// Logs carry ids, the server origin, counts and times only, never text or titles.

export interface TurnSlotRequest {
  requestId: string;
  /** Every id the turn's chat goes by; the first is the one logs name. */
  sessionIds: string[];
  /** The model server's origin, e.g. `http://127.0.0.1:1234`. */
  server: string;
  /** Turns the server runs at once. Each request carries the server's current limit. */
  limit: number;
  /** Aborting it while the turn waits withdraws the turn. */
  signal: AbortSignal;
  /** Called when the turn starts waiting and whenever its place in line changes. */
  onHeld?: (held: HermesHeldTurn) => void;
}

export type TurnSlot =
  | { kind: 'admitted'; waitedMs: number; release: () => void }
  | { kind: 'withdrawn'; waitedMs: number; reason: unknown };

interface Waiting {
  request: TurnSlotRequest;
  heldAt: number;
  resolve: (slot: TurnSlot) => void;
  onAbort: () => void;
  /** The last place in line `onHeld` reported, so an unchanged place isn't sent again. */
  reported: string;
}

interface Server {
  limit: number;
  /** Admitted turns by request id, with their chat ids. */
  running: Map<string, string[]>;
  waiting: Waiting[];
}

const servers = new Map<string, Server>();

function serverFor(origin: string, limit: number): Server {
  let server = servers.get(origin);
  if (!server) {
    server = { limit, running: new Map(), waiting: [] };
    servers.set(origin, server);
  }
  // The newest send carries the setting as it is now.
  server.limit = Math.max(1, Math.floor(limit));
  return server;
}

function logFields(request: TurnSlotRequest, server: Server): Record<string, unknown> {
  return {
    requestId: request.requestId,
    sessionId: request.sessionIds[0] ?? null,
    server: request.server,
    limit: server.limit,
    running: server.running.size,
  };
}

function admit(server: Server, request: TurnSlotRequest, heldAt: number, how: 'free' | 'released' | 'run-now'): TurnSlot {
  server.running.set(request.requestId, request.sessionIds);
  const waitedMs = Date.now() - heldAt;
  persistDebugLog('chat-turn', 'turn admitted', { ...logFields(request, server), waitedMs, how });
  let released = false;
  return {
    kind: 'admitted',
    waitedMs,
    release: () => {
      if (released) return;
      released = true;
      server.running.delete(request.requestId);
      drain(server);
    },
  };
}

function heldInfo(server: Server, index: number): HermesHeldTurn {
  return {
    position: index + 1,
    ahead: server.running.size + index,
    limit: server.limit,
    runningSessionIds: [...server.running.values()].map((ids) => ids[0]).filter(Boolean),
  };
}

/** Tells each waiting turn its place, when it changed. */
function reportPlaces(server: Server): void {
  server.waiting.forEach((entry, index) => {
    const info = heldInfo(server, index);
    const key = JSON.stringify(info);
    if (key === entry.reported) return;
    entry.reported = key;
    entry.request.onHeld?.(info);
  });
}

function drain(server: Server): void {
  while (server.waiting.length > 0 && server.running.size < server.limit) {
    const next = server.waiting.shift()!;
    next.request.signal.removeEventListener('abort', next.onAbort);
    next.resolve(admit(server, next.request, next.heldAt, 'released'));
  }
  reportPlaces(server);
}

/**
 * Resolves when the turn may submit (`admitted`, with `release` to call when it ends), or when
 * its signal aborts while it waits (`withdrawn`). A turn admitted at once never calls `onHeld`.
 */
export function requestTurnSlot(request: TurnSlotRequest): Promise<TurnSlot> {
  const server = serverFor(request.server, request.limit);
  const heldAt = Date.now();
  if (request.signal.aborted) {
    return Promise.resolve({ kind: 'withdrawn', waitedMs: 0, reason: request.signal.reason });
  }
  if (server.waiting.length === 0 && server.running.size < server.limit) {
    return Promise.resolve(admit(server, request, heldAt, 'free'));
  }
  return new Promise<TurnSlot>((resolve) => {
    const entry: Waiting = {
      request,
      heldAt,
      resolve,
      reported: '',
      onAbort: () => {
        const index = server.waiting.indexOf(entry);
        if (index < 0) return;
        server.waiting.splice(index, 1);
        persistDebugLog('chat-turn', 'turn withdrawn', {
          ...logFields(request, server),
          waitedMs: Date.now() - heldAt,
        });
        resolve({ kind: 'withdrawn', waitedMs: Date.now() - heldAt, reason: request.signal.reason });
        reportPlaces(server);
      },
    };
    server.waiting.push(entry);
    request.signal.addEventListener('abort', entry.onAbort, { once: true });
    persistDebugLog('chat-turn', 'turn held', {
      ...logFields(request, server),
      position: server.waiting.length,
    });
    reportPlaces(server);
  });
}

/** **Run now**: admits a waiting turn over its server's limit. False when it isn't waiting. */
export function runHeldTurnNow(requestId: string): boolean {
  for (const server of servers.values()) {
    const index = server.waiting.findIndex((entry) => entry.request.requestId === requestId);
    if (index < 0) continue;
    const [entry] = server.waiting.splice(index, 1);
    entry.request.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(admit(server, entry.request, entry.heldAt, 'run-now'));
    reportPlaces(server);
    return true;
  }
  return false;
}

/** Request ids of every waiting turn, oldest first per server. */
export function heldTurnRequestIds(): string[] {
  return [...servers.values()].flatMap((server) => server.waiting.map((entry) => entry.request.requestId));
}

let quitWithdraw: (() => Promise<number>) | null = null;

/** The chat module registers how a held turn is withdrawn, so main's quit needn't import it. */
export function setHeldTurnQuitWithdraw(withdraw: () => Promise<number>): void {
  quitWithdraw = withdraw;
}

/** Withdraws every held turn before quitting; resolves with how many there were. */
export function withdrawHeldTurnsForQuit(): Promise<number> {
  return quitWithdraw ? quitWithdraw() : Promise.resolve(0);
}

export function resetWorkloadSchedulerForTests(): void {
  for (const server of servers.values()) {
    for (const entry of server.waiting) entry.request.signal.removeEventListener('abort', entry.onAbort);
  }
  servers.clear();
}
