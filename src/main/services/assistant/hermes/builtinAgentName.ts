import { BUILTIN_ASSISTANT_SLUG, type AgentProfile } from '../../../../shared/types/hermesChat';
import { broadcast } from '../../windows';

type NameSource = () => string | null;

let source: NameSource | null = null;

/**
 * Lets a build name the built-in agent from somewhere other than its stored record, such as a
 * name the user chose elsewhere in the app. The source is read on every agent list, so the
 * name it returns becomes the built-in agent's display name and handle everywhere main reads
 * the record: the chat lists, room headers and the check that new agents don't take its name.
 * A blank answer, or a source that throws, keeps the stored name.
 */
export function setBuiltinAgentNameSource(next: NameSource | null): void {
  source = next;
}

/** Tells open windows to list agents again, after the source's answer changed. */
export function notifyBuiltinAgentNameChanged(): void {
  broadcast('hermes-agents:changed');
}

/** The agent with the source's name, if it is the built-in agent and the source has one. */
export function withBuiltinAgentName(agent: AgentProfile): AgentProfile {
  if (agent.slug !== BUILTIN_ASSISTANT_SLUG || !source) return agent;
  let name: string | null;
  try {
    name = source()?.trim() || null;
  } catch {
    name = null;
  }
  if (!name || (name === agent.displayName && name === agent.handle)) return agent;
  return { ...agent, displayName: name, handle: name };
}
