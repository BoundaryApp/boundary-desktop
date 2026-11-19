import fs from 'node:fs';
import path from 'node:path';
import type {
  DetectorCheckResult,
  DetectorErrorCode,
  DetectorProvider,
  DetectorScore,
  DetectorSegment,
  DetectorStatus,
} from '../../../../shared/types/writingCheck';
import { persistDebugLog } from '../../../persistDebugLog';
import { readEnvFile } from '../stackEnv';

/**
 * The stack's AI text detector add-on (CR 0030, stack v0.3.14 `docs/detector.md`), for the
 * writing check's detector score (writing check spec, phase 5). Main holds the token: it reads
 * `<data root>/addons/detector/secrets/http_token` on every call, and again once after a 401
 * because `scripts/detector.sh rotate` replaces it. The renderer only sees results.
 */

export interface DetectorDeps {
  /** The active stack checkout, or null when there is none. */
  stackRoot(): string | null;
  /** The stack's data root for a checkout (`ASSISTANT_DATA_ROOT`, default `<root>/data`). */
  dataRoot(root: string): string;
  fetch: typeof fetch;
  consent: { has(provider: DetectorProvider): boolean; add(provider: DetectorProvider): void };
}

const DEFAULT_PORT = '8790';
const HEALTH_TIMEOUT_MS = 3_000;
/** The add-on gives up on the provider after 60 s and answers 504; allow for that answer. */
const CHECK_TIMEOUT_MS = 75_000;

const PROVIDERS: readonly DetectorProvider[] = ['pangram', 'gptzero'];
const ERROR_CODES: readonly DetectorErrorCode[] = [
  'too_short',
  'too_long',
  'no_key',
  'quota',
  'provider_error',
  'timeout',
  'bad_input',
  'unauthorized',
  'forbidden',
];

const UNAVAILABLE = 'The detector add-on isn’t answering. Is the stack running?';
const REFUSED_TOKEN = 'The detector add-on refused Boundary’s token.';
const UNREADABLE = 'The detector add-on sent an answer Boundary couldn’t read.';

interface Endpoint {
  baseUrl: string;
  tokenPath: string;
  manifestPath: string;
}

function endpoint(deps: DetectorDeps): Endpoint | null {
  const root = deps.stackRoot();
  if (!root) return null;
  const port = readEnvFile(path.join(root, '.env')).DETECTOR_PORT?.trim() || DEFAULT_PORT;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokenPath: path.join(deps.dataRoot(root), 'addons', 'detector', 'secrets', 'http_token'),
    manifestPath: path.join(root, 'addons', 'detector', 'addon.json'),
  };
}

function readToken(tokenPath: string): string | null {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function readDataLeaves(manifestPath: string): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      store?: { dataLeaves?: unknown };
    };
    const text = manifest.store?.dataLeaves;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

const isProvider = (value: unknown): value is DetectorProvider =>
  typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function logStatus(reason: string): void {
  persistDebugLog('writing-check', 'detector status', { reason });
}

/** Available only when the add-on is in this stack, has its token, and answers /health. */
export async function detectorStatus(deps: DetectorDeps): Promise<DetectorStatus> {
  const at = endpoint(deps);
  if (!at) return { available: false };
  const dataLeaves = readDataLeaves(at.manifestPath);
  if (!dataLeaves) return { available: false };
  const token = readToken(at.tokenPath);
  if (!token) {
    logStatus('no_token');
    return { available: false };
  }
  try {
    const response = await deps.fetch(`${at.baseUrl}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    const body = (await response.json()) as { ok?: unknown; provider?: unknown };
    if (!response.ok || body.ok !== true || !isProvider(body.provider)) {
      logStatus(`health_${response.status}`);
      return { available: false };
    }
    return {
      available: true,
      provider: body.provider,
      dataLeaves,
      consented: deps.consent.has(body.provider),
    };
  } catch {
    logStatus('no_answer');
    return { available: false };
  }
}

function parseScore(body: unknown, textLength: number): DetectorScore | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (!isProvider(raw.provider) || !isUnit(raw.score) || typeof raw.checkedAt !== 'string') return null;
  const segments: DetectorSegment[] = Array.isArray(raw.segments)
    ? raw.segments.flatMap((segment): DetectorSegment[] => {
        const s = segment as Record<string, unknown>;
        const ok =
          Number.isInteger(s.start) &&
          Number.isInteger(s.end) &&
          (s.start as number) >= 0 &&
          (s.end as number) > (s.start as number) &&
          (s.end as number) <= textLength &&
          isUnit(s.score);
        return ok ? [{ start: s.start as number, end: s.end as number, score: s.score as number }] : [];
      })
    : [];
  return {
    provider: raw.provider,
    score: raw.score,
    ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {}),
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    segments,
    checkedAt: raw.checkedAt,
  };
}

function parseError(body: unknown): { code: DetectorErrorCode; message: string; retryAfter?: number } | null {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  if (!error || !(ERROR_CODES as readonly unknown[]).includes(error.code)) return null;
  const message = typeof error.message === 'string' && error.message ? error.message : String(error.code);
  const retryAfter = typeof error.retryAfter === 'number' && error.retryAfter > 0 ? error.retryAfter : undefined;
  return { code: error.code as DetectorErrorCode, message, ...(retryAfter ? { retryAfter } : {}) };
}

/** Sends `text` to the add-on. Every outcome resolves; nothing here throws. */
export async function checkWithDetector(text: string, deps: DetectorDeps): Promise<DetectorCheckResult> {
  const started = Date.now();
  const finish = (result: DetectorCheckResult, status?: number): DetectorCheckResult => {
    // Metadata only: the text, the token and the provider's answer stay out of the log.
    persistDebugLog('writing-check', 'detector check', {
      outcome: 'error' in result ? result.error.code : 'ok',
      ...(status !== undefined ? { status } : {}),
      ...('score' in result
        ? { provider: result.score.provider, segments: result.score.segments.length }
        : {}),
      chars: text.length,
      ms: Date.now() - started,
    });
    return result;
  };
  const fail = (code: DetectorErrorCode, message: string, status?: number) =>
    finish({ ok: false, error: { code, message } }, status);

  const at = endpoint(deps);
  if (!at) return fail('unavailable', UNAVAILABLE);

  const post = async (): Promise<Response | null> => {
    const token = readToken(at.tokenPath);
    if (!token) return null;
    return deps.fetch(`${at.baseUrl}/check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  };

  let response: Response | null;
  try {
    response = await post();
    // The token may have been rotated since it was read: read it again once.
    if (response?.status === 401) response = await post();
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return timedOut
      ? fail('timeout', 'The detector add-on didn’t answer in time.')
      : fail('unavailable', UNAVAILABLE);
  }
  if (!response) return fail('unavailable', UNAVAILABLE);
  if (response.status === 401) return fail('unauthorized', REFUSED_TOKEN, 401);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fail('provider_error', UNREADABLE, response.status);
  }
  if (response.ok) {
    const score = parseScore(body, text.length);
    return score ? finish({ ok: true, score }, response.status) : fail('provider_error', UNREADABLE, response.status);
  }
  const error = parseError(body);
  return error ? finish({ ok: false, error }, response.status) : fail('provider_error', UNREADABLE, response.status);
}
