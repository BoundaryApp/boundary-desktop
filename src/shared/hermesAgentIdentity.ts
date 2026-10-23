import { BUILTIN_ASSISTANT_SLUG, type AgentProfile } from './types/hermesChat';

/**
 * The built-in agent's identity (ADR 0023 §8). Boundary names it here and nowhere else;
 * every surface reads the stored built-in record through `builtinAgent`. When the stack
 * can swap the base agent (CR 0002 R5), it fills the stored record instead.
 */
export const BUILTIN_AGENT_FALLBACK: AgentProfile = {
  slug: BUILTIN_ASSISTANT_SLUG,
  displayName: 'Hermes',
  handle: 'Hermes',
  role: 'Default agent on this machine.',
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
};

/** The record before ADR 0023; stored copies that still match it are migrated. */
export const LEGACY_BUILTIN_NAME = 'Assistant';

/** The built-in record from a loaded agent list, or the fallback before it loads. */
export function builtinAgent(agents?: readonly AgentProfile[] | null): AgentProfile {
  return agents?.find((a) => a.slug === BUILTIN_ASSISTANT_SLUG) ?? BUILTIN_AGENT_FALLBACK;
}

/** Display name of the built-in agent. */
export function builtinAgentName(agents?: readonly AgentProfile[] | null): string {
  return builtinAgent(agents).displayName;
}

/** True when a new agent's name or handle would read as the built-in agent. */
export function clashesWithBuiltinAgent(
  name: string,
  agents?: readonly AgentProfile[] | null
): boolean {
  const needle = name.trim().replace(/^@/, '').toLowerCase();
  if (!needle) return false;
  const builtin = builtinAgent(agents);
  return [builtin.displayName, builtin.handle].some((n) => n.trim().toLowerCase() === needle);
}
