import { useEffect, useState } from 'react';
import { builtinAgentName } from '../../shared/hermesAgentIdentity';
import type { AgentProfile } from '../../shared/types/hermesChat';

/** The stored agents, loaded once on mount. Empty until they arrive, and if the call fails. */
export function useStoredAgents(): AgentProfile[] {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  useEffect(() => {
    let alive = true;
    void window.electronAPI.agents
      .list()
      .then((result) => {
        if (alive && result.success) setAgents(result.agents);
      })
      .catch((): void => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return agents;
}

/** Display name of the built-in agent, from its stored record (ADR 0023 §8). */
export function useBuiltinAgentName(): string {
  return builtinAgentName(useStoredAgents());
}

/** A toast message that clears itself four seconds after it is set. */
export function useToast(): [string | null, (message: string | null) => void] {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  return [toast, setToast];
}
