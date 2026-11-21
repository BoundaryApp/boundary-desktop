/**
 * What the gateways a provider runs for their Circle share: the inference gateway (ADR 0034 §2)
 * and the service gateway (ADR 0048 §3). Kept free of native modules, like both gateways.
 */
import type { CircleDayUsage } from '../../../shared/types/circles';

/** Where a request's answer goes: one head, any number of chunks, then one end. */
export interface GatewaySink {
  head(status: number, contentType: string): void;
  chunk(data: Buffer): void;
  /** `error` when the reply stopped after its head. */
  end(error?: string): void;
}

/** What every gateway a provider runs for their Circle needs from main. */
export interface MemberGatewayDeps {
  /** The identity of the current member using `device` in `circle`, or null. */
  memberFor(circle: string, device: string): string | null;
  fetchImpl?: typeof fetch;
  log?(message: string, data?: Record<string, unknown>): void;
  /** Diagnostics events (metadata only): every request's path through the gateway. */
  diag?(event: string, data: Record<string, unknown>): void;
  /** What today's counts started from, kept by main across restarts. */
  usage?: CircleDayUsage;
}

/** Reply bytes go out in pieces no larger than this, so one big read can't hog the stream. */
export const GATEWAY_CHUNK_BYTES = 64 * 1024;

/** An error's class and code, never its message, which for fetch can echo a URL. */
export function errorName(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  return [err.name, cause?.code].filter(Boolean).join(':');
}

function errorBody(message: string): Buffer {
  return Buffer.from(JSON.stringify({ error: { message, type: 'boundary_gateway_error' } }));
}

/** Answers a request with an error before any reply started. */
export function refuse(sink: GatewaySink, status: number, message: string): void {
  sink.head(status, 'application/json');
  sink.chunk(errorBody(message));
  sink.end();
}

/**
 * Sends an upstream reply's body to `sink` in pieces of at most `GATEWAY_CHUNK_BYTES`, calling
 * `onPiece` with each piece as read. Returns how many chunks went out. Throws what the body throws.
 */
export async function pipeBody(response: Response, sink: GatewaySink, onPiece?: (data: Buffer) => void): Promise<number> {
  let chunks = 0;
  if (!response.body) return chunks;
  for await (const piece of response.body as AsyncIterable<Uint8Array>) {
    const data = Buffer.from(piece);
    onPiece?.(data);
    for (let at = 0; at < data.length; at += GATEWAY_CHUNK_BYTES) {
      chunks++;
      sink.chunk(data.subarray(at, at + GATEWAY_CHUNK_BYTES));
    }
  }
  return chunks;
}
