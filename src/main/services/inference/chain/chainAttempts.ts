import type { InferenceChainEntryState } from '../../../../shared/types/inferenceChain';

/** How one attempt at an entry ended, as far as fallback cares (ADR 0033 §6). */
export type ChainAttemptOutcome =
  | { kind: 'served' }
  | { kind: 'unreachable'; detail?: string }
  | { kind: 'header-timeout' }
  | { kind: 'status'; status: number }
  /** The reply had started streaming when it failed. Never retried elsewhere. */
  | { kind: 'failed-mid-stream'; detail?: string };

/** Fallback happens before the first response byte only: unreachable, a header timeout, 429 or 5xx. */
export function shouldFallBack(outcome: ChainAttemptOutcome): boolean {
  switch (outcome.kind) {
    case 'unreachable':
    case 'header-timeout':
      return true;
    case 'status':
      return outcome.status === 429 || outcome.status >= 500;
    case 'served':
    case 'failed-mid-stream':
      return false;
  }
}

/**
 * A request opens a new turn when its last message is the user's. Tool-call steps inside a
 * turn end with a tool result or an assistant message instead.
 */
export function opensNewTurn(messages: ReadonlyArray<{ role?: unknown }>): boolean {
  return messages.at(-1)?.role === 'user';
}

export interface PlanChainAttemptsInput {
  entries: InferenceChainEntryState[];
  /** Key of the entry that served this session's last request, if any. */
  stickyKey?: string | null;
  newTurn: boolean;
  /** Estimated prompt tokens; entries with a smaller known context are skipped. */
  requestTokens?: number;
}

/**
 * Which entries to try, in order (ADR 0033 §6–8). A new turn starts from the top. Inside a
 * turn, the session stays on the entry that served it and only moves further down. Stale
 * entries and entries too small for the request are left out.
 */
export function planChainAttempts(input: PlanChainAttemptsInput): InferenceChainEntryState[] {
  const sticky = input.newTurn || !input.stickyKey
    ? -1
    : input.entries.findIndex((state) => state.key === input.stickyKey);
  const start = sticky < 0 ? 0 : sticky;
  return input.entries.slice(start).filter((state) => {
    if (state.stale) return false;
    if (input.requestTokens && state.contextLength && state.contextLength < input.requestTokens) {
      return false;
    }
    return true;
  });
}

export type ChainRunResult =
  | { ok: true; served: InferenceChainEntryState; tried: ChainAttemptRecord[] }
  | { ok: false; tried: ChainAttemptRecord[] };

export interface ChainAttemptRecord {
  key: string;
  outcome: ChainAttemptOutcome;
}

/**
 * Try `plan` in order until one entry serves or fails in a way that must not fall back.
 * `attempt` performs the request; it resolves once headers arrive or the attempt fails.
 */
export async function runChainAttempts(
  plan: InferenceChainEntryState[],
  attempt: (state: InferenceChainEntryState) => Promise<ChainAttemptOutcome>
): Promise<ChainRunResult> {
  const tried: ChainAttemptRecord[] = [];
  for (const state of plan) {
    const outcome = await attempt(state);
    tried.push({ key: state.key, outcome });
    if (outcome.kind === 'served') return { ok: true, served: state, tried };
    if (!shouldFallBack(outcome)) break;
  }
  return { ok: false, tried };
}
