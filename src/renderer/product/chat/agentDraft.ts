import type { AgentDraftProposal } from '../../../shared/types/hermesChat';

const DRAFT_FENCE = /```agent-draft\s*([\s\S]*?)```/i;

/**
 * Parse a fenced agent-draft block from assistant text.
 * Returns null when no fence is present — never heuristic-guess free prose.
 */
export function parseAgentDraft(text: string): AgentDraftProposal | null {
  const match = DRAFT_FENCE.exec(text);
  if (!match) return null;
  const body = match[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();
    if (value) fields[key] = value;
  }
  const displayName =
    fields.displayname || fields.display_name || fields.name || '';
  const handle =
    (fields.handle || fields.slug || displayName).replace(/^@/, '').trim();
  const role = fields.role || '';
  if (!displayName.trim() || !role.trim()) return null;
  return {
    displayName: displayName.trim(),
    handle: handle || displayName.trim(),
    role: role.trim(),
  };
}

/** The text without its agent-draft block, for showing beside the card that replaces it. */
export function stripAgentDraftFence(text: string): string {
  return text.replace(DRAFT_FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
}
