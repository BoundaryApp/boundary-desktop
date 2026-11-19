import type { HermesReplyEnding, HermesRunControl } from '../../../shared/types/hermesChat';

// Why the next abort happens (run-control spec 2.3). assistant-ui's cancelRun takes no
// reason, so Send now marks the abort it is about to cause; the adapter reads the mark
// when the abort lands and tells main, which notes the ending against the reply's row.
// Replies cut short this way are remembered by message id for the live marker, until a
// reload brings the saved note.

let next: { reason: HermesReplyEnding; via: HermesRunControl } | null = null;
const interrupted = new Set<string>();

/** Call right before cancelRun when the user sends over a running reply. */
export function interruptNextAbort(via: HermesRunControl): void {
  next = { reason: 'interrupted', via };
}

/** The reason for the abort that just landed, and its control: Stop unless Send now marked it. */
export function takeAbortReason(): { reason: HermesReplyEnding; via: HermesRunControl } {
  const taken = next ?? { reason: 'stopped' as const, via: 'stop' as const };
  next = null;
  return taken;
}

export function markReplyInterrupted(messageId: string): void {
  interrupted.add(messageId);
}

export function isReplyInterrupted(messageId: string): boolean {
  return interrupted.has(messageId);
}

/** @internal Vitest only. */
export function resetRunInterruptsForTests(): void {
  next = null;
  interrupted.clear();
}
