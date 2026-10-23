import type {
  HermesChatMessage,
  HermesChatRewindRequest,
} from '../../../../shared/types/hermesChat';

/**
 * Edit and Retry replace a session's history from one user turn onward with
 * `prompt.submit` truncation (message-actions spec, Phase 2). Main re-reads the
 * transcript right before cutting and only cuts at a turn it can prove is the one
 * the renderer means; anything uncertain is refused, never guessed.
 */

export type RewindPlan =
  /** The turn never reached Hermes (e.g. it failed before submit): send normally. */
  | { kind: 'append' }
  | { kind: 'truncate'; rowId: number; confirmEmpty: boolean }
  | { kind: 'refuse'; code: 'rewind-stale' | 'rewind-unsupported'; error: string };

export const REWIND_STALE_MESSAGE =
  'This message changed in Hermes since the chat loaded. Reopen the chat and try again.';
export const REWIND_UNSUPPORTED_MESSAGE =
  'This Hermes version can’t edit or retry messages. Update the agent stack to v2026.9.14 or later.';

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Stored and sent text can differ in whitespace, or by a prefix Hermes adds. */
function sameTurnText(stored: string, expected: string): boolean {
  const a = normalize(stored);
  const b = normalize(expected);
  if (!a || !b) return a === b;
  return a === b || a.includes(b) || b.includes(a);
}

export function planRewind(
  history: HermesChatMessage[],
  request: HermesChatRewindRequest
): RewindPlan {
  const users = history.filter((m) => m.role === 'user');
  let index: number;
  if (request.rowId != null) {
    index = users.findIndex((m) => m.rowId === request.rowId);
    if (index < 0) {
      return { kind: 'refuse', code: 'rewind-stale', error: REWIND_STALE_MESSAGE };
    }
  } else {
    if (request.userOrdinal >= users.length) return { kind: 'append' };
    index = request.userOrdinal;
  }

  const target = users[index];
  if (!sameTurnText(target.content, request.expectedText)) {
    return { kind: 'refuse', code: 'rewind-stale', error: REWIND_STALE_MESSAGE };
  }
  if (target.rowId == null) {
    return { kind: 'refuse', code: 'rewind-unsupported', error: REWIND_UNSUPPORTED_MESSAGE };
  }
  // Cutting before the first turn empties the session, which Hermes makes a separate opt-in.
  return { kind: 'truncate', rowId: target.rowId, confirmEmpty: index === 0 };
}

/** Readable text for a gateway refusal of a truncating `prompt.submit`. */
export function describeRewindError(err: unknown): string {
  const code =
    err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'number'
      ? (err as { code: number }).code
      : null;
  if (code === 4018 || code === 4030) return REWIND_STALE_MESSAGE;
  if (code === 4004 || code === 4028 || code === 4029) return REWIND_UNSUPPORTED_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}
