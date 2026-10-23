import { localDayKey } from '../../../shared/messageTime';

interface TimedMessage {
  createdAt?: Date;
  metadata?: { custom?: Record<string, unknown> };
}

/**
 * When a message was sent, in ms, or null when its source had no time.
 * Hydrated history always carries `custom.ts` (see toThreadMessage); live turns
 * do not, and use the runtime's `createdAt`.
 */
export function messageTimeMs(message: TimedMessage | undefined): number | null {
  if (!message) return null;
  const custom = message.metadata?.custom;
  if (custom && 'ts' in custom) {
    return typeof custom.ts === 'number' ? custom.ts * 1000 : null;
  }
  return message.createdAt instanceof Date ? message.createdAt.getTime() : null;
}

/**
 * Whether a day divider goes above a message: the first timed message, or one on a
 * different local day from the message before it. Skipped when either time is unknown.
 */
export function needsDayDivider(
  index: number,
  timeMs: number | null,
  prevTimeMs: number | null
): boolean {
  if (timeMs == null) return false;
  if (index === 0) return true;
  if (prevTimeMs == null) return false;
  return localDayKey(prevTimeMs) !== localDayKey(timeMs);
}
