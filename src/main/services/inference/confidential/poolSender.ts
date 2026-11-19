import type { PoolMoveReason, TrustLevel } from '../../../../shared/types/confidential';
import type { SpendEntry } from '../../../../shared/types/confidentialState';
import type { ChainAttemptOutcome } from '../chain/chainAttempts';
import { failureMovesOn, type AdapterChatResult, type AdapterFailure, type ConfidentialAdapter } from './adapter';
import { CALL_TIMEOUT_MS, type ConfidentialService } from './confidentialService';
import { choosePoolProvider } from './pool';
import { costOfCounts, usageCounts } from './prices';
import { meterUsage } from './usageMeter';

/**
 * Sends one request to a confidential pool (ADR 0047 §8). A session stays on the provider that
 * served it until that provider fails or stops serving; a new session gets the provider
 * `choosePoolProvider` picks. Before the first byte, a failure that is the provider's problem
 * moves on to the next serving provider; a request error ends the pool.
 */

const SESSION_LIMIT = 500;
/**
 * How long a provider may take to start answering a chat. The router sets no header timer when
 * the pool is the chain's last or only entry, so without this a hung provider holds every turn.
 */
const POOL_HEAD_TIMEOUT_MS = 60_000;

export interface PoolSendContext {
  sessionKey: string | null;
  privateProject: boolean;
  projectFloor?: TrustLevel;
  requestTokens?: number;
  tools: boolean;
}

export type PoolSendResult =
  | { ok: true; response: Response; providerId: string; providerModelId: string; moved: PoolMoveReason | null }
  | { ok: false; outcome: ChainAttemptOutcome };

export interface PoolSender {
  send(modelId: string, body: Record<string, unknown>, signal: AbortSignal, ctx: PoolSendContext): Promise<PoolSendResult>;
}

interface SessionEntry {
  providerId: string | null;
  /**
   * The provider that last broke a reply in this session. The next request tries it last and its
   * move says why, even before the provider's cooldown reaches the ranking.
   */
  brokeOff?: string;
  /** Provider and model pairs (`providerId\u0000providerModelId`) whose hardware check passed in this session. */
  attested: Set<string>;
}

/** Sessions remember their provider and checked hardware, oldest dropped first. */
class PoolSessions {
  private readonly map = new Map<string, SessionEntry>();

  get(session: string | null): SessionEntry | null {
    return session ? (this.map.get(session) ?? null) : null;
  }

  /** The session's entry, created and moved to newest. A null session gets a throwaway entry. */
  touch(session: string | null): SessionEntry {
    if (!session) return { providerId: null, attested: new Set() };
    const entry = this.map.get(session) ?? { providerId: null, attested: new Set<string>() };
    this.map.delete(session);
    this.map.set(session, entry);
    if (this.map.size > SESSION_LIMIT) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return entry;
  }
}

const CLIENT_CLOSED: PoolSendResult = { ok: false, outcome: { kind: 'failed-mid-stream', detail: 'client closed' } };

/** One attempt's result, or that the sender's own timer ran out or the caller aborted first. */
type Timed<T> = { kind: 'value'; value: T } | { kind: 'timed-out' } | { kind: 'aborted' };

/**
 * Runs `run` with a signal that aborts when the caller's does or after `ms`. Resolves when `run`
 * does, as `timed-out` when the timer fires first, or as `aborted` as soon as the caller aborts,
 * even if `run` ignores its signal; a result that arrives after either goes to `late`.
 */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  caller: AbortSignal,
  ms: number,
  late?: (value: T) => void
): Promise<Timed<T>> {
  const timer = new AbortController();
  let handle: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<'timed-out' | 'aborted'>((resolve) => {
    handle = setTimeout(() => {
      timer.abort();
      resolve('timed-out');
    }, ms);
    onAbort = (): void => resolve('aborted');
    if (caller.aborted) onAbort();
    else caller.addEventListener('abort', onAbort, { once: true });
  });
  const pending = run(AbortSignal.any([caller, timer.signal]));
  try {
    const first = await Promise.race([pending.then((value) => ({ value })), stopped]);
    if (typeof first === 'object') return { kind: 'value', value: first.value };
    void pending.then(
      (result) => late?.(result),
      (): undefined => undefined
    );
    return { kind: first };
  } finally {
    clearTimeout(handle);
    if (onAbort) caller.removeEventListener('abort', onAbort);
  }
}

/**
 * Whether the caller stopped waiting because its own timer ran out: the router aborts a pool that
 * isn't the chain's last entry with a `TimeoutError` when no first byte came in time. Any other
 * abort is the client leaving.
 */
function callerTimedOut(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError';
}

const HEADER_TIMEOUT: PoolSendResult = { ok: false, outcome: { kind: 'header-timeout' } };

export function createPoolSender(deps: {
  service: Pick<ConfidentialService, 'rank' | 'adapter' | 'noteFailure' | 'state'>;
  log?: (message: string, data: Record<string, unknown>) => void;
  /** Gets one entry per served reply, when its body ends, errors or is cancelled. */
  recordSpend?: (entry: SpendEntry) => void;
}): PoolSender {
  const sessions = new PoolSessions();
  /** The provider last picked for a new session, which Prefer one provider keeps new sessions on. */
  let lastPicked: string | null = null;

  /**
   * Whether the provider's hardware check passed, failed, or couldn't run: the adapter said
   * unreachable, threw, or didn't answer in time.
   */
  async function attest(
    adapter: ConfidentialAdapter,
    entry: SessionEntry,
    providerModelId: string,
    signal: AbortSignal
  ): Promise<'passed' | 'failed' | 'unreachable'> {
    const key = `${adapter.providerId}\u0000${providerModelId}`;
    if (entry.attested.has(key)) return 'passed';
    const checked = await withTimeout(
      async (attempt): Promise<'passed' | 'failed' | 'unreachable'> => {
        try {
          const result = await adapter.verifyAttestation(providerModelId, attempt);
          if (result.ok === true) return 'passed';
          return result.unreachable === true ? 'unreachable' : 'failed';
        } catch {
          return 'unreachable';
        }
      },
      signal,
      CALL_TIMEOUT_MS
    );
    if (checked.kind !== 'value') return 'unreachable';
    if (checked.value === 'passed') entry.attested.add(key);
    return checked.value;
  }

  /** The provider's answer, or `unreachable` when it throws or sends nothing before the head timeout. */
  async function chat(adapter: ConfidentialAdapter, body: string, signal: AbortSignal): Promise<AdapterChatResult> {
    const answered = await withTimeout(
      async (attempt): Promise<AdapterChatResult> => {
        try {
          return await adapter.chat(body, attempt);
        } catch {
          // The error text could quote the request, so only the kind is kept.
          return { ok: false, failure: { kind: 'unreachable' } };
        }
      },
      signal,
      POOL_HEAD_TIMEOUT_MS,
      // An answer after the timeout has nowhere to go.
      (late) => {
        if (late.ok === true) void late.response.body?.cancel().catch((): undefined => undefined);
      }
    );
    return answered.kind === 'value' ? answered.value : { ok: false, failure: { kind: 'unreachable' } };
  }

  return {
    async send(modelId, body, signal, ctx) {
      const log = (provider: string | null, moved: PoolMoveReason | null, outcome: string): void => {
        deps.log?.('confidential pool send', {
          session: ctx.sessionKey ? ctx.sessionKey.slice(0, 8) : null,
          model: modelId,
          provider,
          moved,
          outcome,
        });
      };

      const ranking = await deps.service.rank(modelId, {
        privateProject: ctx.privateProject,
        projectFloor: ctx.projectFloor,
        request: { tools: ctx.tools, ...(ctx.requestTokens === undefined ? {} : { tokens: ctx.requestTokens }) },
      });
      const state = await deps.service.state();
      if (!ranking || ranking.serving.length === 0 || state.enabled === false) {
        log(null, null, 'no-provider');
        return { ok: false, outcome: { kind: 'unreachable' } };
      }

      const entry = sessions.touch(ctx.sessionKey);
      const stickyId = entry.providerId;
      const stickyServes = stickyId !== null && ranking.serving.some((c) => c.providerId === stickyId);
      const avoid = entry.brokeOff;
      const choosable = avoid && ranking.serving.length > 1
        ? { ...ranking, serving: ranking.serving.filter((c) => c.providerId !== avoid) }
        : ranking;
      const first = stickyServes
        ? stickyId
        : (choosePoolProvider(choosable, {
            settings: state.settings,
            stickyProviderId: stickyId,
            preferredProviderId: lastPicked === avoid ? null : lastPicked,
          })?.providerId ?? choosable.serving[0].providerId);
      const order = [
        ranking.serving.find((c) => c.providerId === first)!,
        ...ranking.serving.filter((c) => c.providerId !== first && c.providerId !== avoid),
        ...ranking.serving.filter((c) => c.providerId !== first && c.providerId === avoid),
      ];

      /**
       * The caller stopped waiting. A header timeout while `waitingOn` was attesting or answering
       * counts against that provider; the client leaving counts against no one.
       */
      const stop = (providerId: string, waitingOn: boolean): PoolSendResult => {
        if (!callerTimedOut(signal)) {
          log(providerId, moved, 'client-closed');
          return CLIENT_CLOSED;
        }
        if (waitingOn) deps.service.noteFailure(providerId, { kind: 'unreachable' });
        log(providerId, moved, 'header-timeout');
        return HEADER_TIMEOUT;
      };

      let moved: PoolMoveReason | null = stickyServes
        ? null
        : avoid
          ? first === avoid
            ? null
            : 'server'
          : stickyId === null
            ? 'new-session'
            : 'stopped-serving';

      /**
       * A reply that broke after its head counts against its provider and moves the session off
       * it. Nothing is retried: Hermes may already hold part of the reply.
       */
      const brokeOff = (providerId: string, failure: AdapterFailure): void => {
        deps.service.noteFailure(providerId, failure);
        if (entry.providerId === providerId) {
          entry.providerId = null;
          entry.brokeOff = providerId;
        }
        deps.log?.('confidential pool send', {
          session: ctx.sessionKey ? ctx.sessionKey.slice(0, 8) : null,
          model: modelId,
          provider: providerId,
          moved: null,
          outcome: 'broke-mid-stream',
        });
      };
      const moveOn = (providerId: string, failure: AdapterFailure, reason: PoolMoveReason): void => {
        deps.service.noteFailure(providerId, failure);
        if (entry.providerId === providerId) entry.providerId = null;
        moved = reason;
      };

      for (const candidate of order) {
        const { providerId } = candidate;
        if (signal.aborted) return stop(providerId, false);
        const adapter = await deps.service.adapter(providerId);
        if (!adapter) {
          // The key can't be read now; the next refresh marks it, so nothing is noted here.
          moved = 'bad-key';
          continue;
        }
        const providerModelId = candidate.offer.providerModelId;
        const attested = await attest(adapter, entry, providerModelId, signal);
        if (attested !== 'passed') {
          if (signal.aborted) return stop(providerId, true);
          if (attested === 'unreachable') moveOn(providerId, { kind: 'unreachable' }, 'unreachable');
          else moveOn(providerId, { kind: 'attestation-failed' }, 'attestation-failed');
          continue;
        }
        const result = await chat(adapter, JSON.stringify({ ...body, model: providerModelId }), signal);
        if (signal.aborted) {
          if (result.ok === true) void result.response.body?.cancel().catch((): undefined => undefined);
          return stop(providerId, true);
        }
        if (result.ok === true) {
          if (!stickyServes) lastPicked = providerId;
          entry.providerId = providerId;
          entry.brokeOff = undefined;
          void result.failed?.then((failure) => brokeOff(providerId, failure));
          log(providerId, moved, 'served');
          const response = deps.recordSpend
            ? meterUsage(result.response, (usage) => {
                const counts = usageCounts(usage);
                deps.recordSpend?.({
                  at: Date.now(),
                  providerId,
                  modelId,
                  inputTokens: counts?.inputTokens ?? null,
                  cachedTokens: counts?.cachedTokens ?? null,
                  outputTokens: counts?.outputTokens ?? null,
                  cost: counts ? costOfCounts(candidate.price, counts) : null,
                });
              })
            : result.response;
          return { ok: true, response, providerId, providerModelId, moved };
        }
        const { failure } = result;
        if (failure.kind === 'mid-stream') {
          // The provider answered but its reply couldn't be read: count it, and don't try another.
          entry.providerId = providerId;
          brokeOff(providerId, failure);
          return { ok: false, outcome: { kind: 'failed-mid-stream' } };
        }
        if (!failureMovesOn(failure)) {
          // A request error: another provider wouldn't fare better.
          const status = failure.kind === 'server' ? failure.status : 400;
          log(providerId, moved, `status-${status}`);
          const overflow = failure.kind === 'server' && failure.contextOverflow === true;
          return { ok: false, outcome: overflow ? { kind: 'status', status, contextOverflow: true } : { kind: 'status', status } };
        }
        moveOn(providerId, failure, failure.kind);
      }
      log(null, moved, 'unreachable');
      return { ok: false, outcome: { kind: 'unreachable' } };
    },
  };
}
