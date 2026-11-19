import { useEffect, useRef, useState } from 'react';
import { builtinAgentName } from '../../../shared/hermesAgentIdentity';
import { BUILTIN_ASSISTANT_SLUG, type AgentProfile } from '../../../shared/types/hermesChat';
import { useRunningTurns } from '../chat/runningTurns';

/** The built-in agent's name, read once; the fallback name until the list arrives. */
export function useBuiltinName(): string {
  const [agents, setAgents] = useState<AgentProfile[] | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => window.electronAPI.agents.list())
      .then((result) => {
        if (live && result.success) setAgents(result.agents);
      })
      .catch((): void => undefined);
    return () => {
      live = false;
    };
  }, []);
  return builtinAgentName(agents);
}

const isBuiltin = (slug: string | null): boolean => slug === null || slug === BUILTIN_ASSISTANT_SLUG;

/**
 * Whether a turn with the built-in agent is running, and whether one ended while the user was
 * away from Chat and hadn't opened the agent since (spec decision 2).
 */
export function useAgentActivity(hidden: boolean): { running: boolean; replied: boolean; clear: () => void } {
  const turns = useRunningTurns().filter((turn) => isBuiltin(turn.agentSlug));
  const ids = turns.map((turn) => turn.requestId);
  const [replied, setReplied] = useState(false);
  const seen = useRef<string[]>(ids);
  const key = ids.join(',');
  useEffect(() => {
    const now = key ? key.split(',') : [];
    const ended = seen.current.some((id) => !now.includes(id));
    seen.current = now;
    if (ended && !hidden) setReplied(true);
  }, [key, hidden]);
  // On Chat the reply is in view.
  useEffect(() => {
    if (hidden) setReplied(false);
  }, [hidden]);
  return { running: ids.length > 0, replied, clear: () => setReplied(false) };
}
