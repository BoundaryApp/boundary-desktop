import type { HermesHistoryWindow } from '../../../shared/types/hermesChat';

interface RowMessage {
  metadata?: { custom?: Record<string, unknown> };
}

export interface HorizonPlacement {
  /** Index of the first message the next reply sees; the line goes above it. */
  index: number;
  window: HermesHistoryWindow & { budget: number };
}

const rowIdOf = (message: RowMessage): number | null => {
  const id = message.metadata?.custom?.rowId;
  return typeof id === 'number' ? id : null;
};

/**
 * Where the DM context horizon goes (chat types Phase 7b). The stack reports the cut and
 * desktop never estimates it. Draw only when there is a budget and the cut drops or
 * summarises something: the summary flag is set, or the first included row isn't the
 * thread's first row. Nothing is drawn when that row isn't loaded.
 */
export function horizonPlacement(
  window: HermesHistoryWindow | null | undefined,
  messages: readonly RowMessage[]
): HorizonPlacement | null {
  if (!window || window.budget == null || window.firstRowId == null) return null;
  const index = messages.findIndex((m) => rowIdOf(m) === window.firstRowId);
  if (index < 0) return null;
  const firstRow = messages.map(rowIdOf).find((id) => id != null);
  if (!window.summarised && firstRow === window.firstRowId) return null;
  return { index, window: { ...window, budget: window.budget } };
}

/** "6k", "6.4k", "950". */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** The line's words: what the agent sees, and how much of the budget it uses. */
export function horizonLabel(agentName: string, window: HermesHistoryWindow & { budget: number }): string {
  const lead = window.summarised
    ? `Earlier messages are summarised for ${agentName}`
    : `${agentName}’s next reply sees from here down`;
  const used =
    window.tokens != null
      ? ` · about ${formatTokenCount(window.tokens)} of ${formatTokenCount(window.budget)} tokens`
      : '';
  return `${lead}${used}`;
}
