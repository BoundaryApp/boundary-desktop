import type { ModelPrice, Precision } from '../../../../shared/types/confidential';

/**
 * One confidential provider, as the router talks to it (ADR 0047 §2). An adapter encrypts
 * requests, checks the provider's hardware, lists its models, reads the balance and maps the
 * provider's errors to the kinds below. Each provider gets its own; phase 2 has only a fake.
 */

export type AdapterFailure =
  | { kind: 'rate-limited'; retryAfterMs?: number }
  | { kind: 'no-balance' }
  | { kind: 'bad-key' }
  | { kind: 'unreachable'; detail?: string }
  | { kind: 'attestation-failed'; detail?: string }
  /** `contextOverflow`: a request error whose body says the request is longer than the model's context. */
  | { kind: 'server'; status: number; contextOverflow?: true }
  /** The reply had started streaming. Never retried elsewhere. */
  | { kind: 'mid-stream'; detail?: string };

/**
 * True when the pool should try its next provider (ADR 0047 §8). Every failure before the first
 * byte that is this provider's problem moves on; a 4xx other than those mapped above is the
 * request's problem and wouldn't fare better elsewhere.
 */
export function failureMovesOn(failure: AdapterFailure): boolean {
  if (failure.kind === 'mid-stream') return false;
  if (failure.kind === 'server') return failure.status >= 500;
  return true;
}

/** A model as the provider's own API lists it. */
export interface ListedOffer {
  providerModelId: string;
  contextLength: number | null;
  precision: Precision | null;
  price: ModelPrice | null;
}

/**
 * A hardware check's result. `unreachable` marks a check that couldn't run (a network error, a
 * provider's 5xx or 429, an abort) as opposed to evidence that failed; neither lets a chat send.
 */
export type AttestationResult = { ok: true } | { ok: false; detail: string; unreachable?: true };

export type AdapterChatResult =
  | {
      ok: true;
      response: Response;
      /**
       * Settles, with a `mid-stream` failure, only if the reply breaks after its head (a stream that
       * doesn't decrypt, ends in an error or is cut off). A clean end or an abort leaves it pending.
       */
      failed?: Promise<AdapterFailure>;
    }
  | { ok: false; failure: AdapterFailure };

export interface ConfidentialAdapter {
  readonly providerId: string;
  /** Whether the provider accepts the API key. */
  checkKey(signal: AbortSignal): Promise<{ ok: true } | { ok: false; failure: AdapterFailure }>;
  /** Checks the provider's hardware for one model. `null` checks the first model the adapter knows. */
  verifyAttestation(providerModelId: string | null, signal: AbortSignal): Promise<AttestationResult>;
  listModels(signal: AbortSignal): Promise<ListedOffer[]>;
  /** USD, or null when the provider can't report it. */
  readBalance(signal: AbortSignal): Promise<number | null>;
  /** Sends a request with one tool and reports whether a tool call came back. */
  testToolCall(signal: AbortSignal): Promise<boolean>;
  /** `body` is an OpenAI chat completions request. Resolves at the reply's head. */
  chat(body: string, signal: AbortSignal): Promise<AdapterChatResult>;
}
