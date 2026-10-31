import type { HermesRecoveryWait } from '../../../../shared/types/hermesChat';

// Hermes parks a turn on its recovery ladder when a provider stays unavailable, and says so only
// in text: `agent/turn_recovery_autorecover.py` `ladder_notice`, sent as a `status.update` of kind
// `lifecycle`. The stack contract's live case runs that function, so a new wording fails there.
const LADDER_NOTICE = /retrying automatically in (\d+)s \(cycle (\d+)\/(\d+)\)/;

/** The wait a `status.update` announces, or null for any other status. */
export function parseRecoveryNotice(payload: unknown): Omit<HermesRecoveryWait, 'provider'> | null {
  const { kind, text } = (payload ?? {}) as { kind?: unknown; text?: unknown };
  if (kind !== 'lifecycle' || typeof text !== 'string') return null;
  const match = LADDER_NOTICE.exec(text);
  if (!match) return null;
  return { retryInSec: Number(match[1]), cycle: Number(match[2]), total: Number(match[3]) };
}
