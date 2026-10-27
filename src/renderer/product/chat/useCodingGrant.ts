import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodingAgentBusy, CodingFoldersResult } from '../../../shared/types/codingFolders';
import {
  codingChange,
  readCodingAgentBusy,
  type CodingChangeMode,
  type CodingChangeRun,
} from './codingFoldersStore';

export interface CodingGrant {
  /**
   * The last busy answer: from `check`, or from a grant main refused because a coding task
   * started after the check. Null until checked. Callers show the wait-or-stop choice on `busy`.
   */
  agent: CodingAgentBusy | null;
  /** Asks whether a coding task is running, and keeps the answer in `agent`. */
  check: () => Promise<CodingAgentBusy>;
  /**
   * Runs the grant change in the chosen mode. A result refused as busy is kept in `agent`, so
   * the caller offers the choice again instead of dropping the grant.
   */
  apply: <R extends CodingFoldersResult>(
    paths: readonly string[],
    mode: CodingChangeMode,
    run: CodingChangeRun<R>
  ) => Promise<R>;
  /** Forgets the busy answer, e.g. when the folder or the step changes. */
  reset: () => void;
}

/** The busy check and the now / stop / queue dispatch for every coding-grant entry point. */
export function useCodingGrant(): CodingGrant {
  const [agent, setAgent] = useState<CodingAgentBusy | null>(null);
  // Only the latest check or reset may set the answer, and never after unmount.
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    seq.current += 1;
    setAgent(null);
  }, []);

  const check = useCallback(async () => {
    const mine = ++seq.current;
    setAgent(null);
    const next = await readCodingAgentBusy();
    if (mounted.current && mine === seq.current) setAgent(next);
    return next;
  }, []);

  const apply = useCallback(
    async <R extends CodingFoldersResult>(
      paths: readonly string[],
      mode: CodingChangeMode,
      run: CodingChangeRun<R>
    ): Promise<R> => {
      const result = await codingChange(paths, mode, run);
      if (result.busy?.busy && mounted.current) {
        seq.current += 1;
        setAgent(result.busy);
      }
      return result;
    },
    []
  );

  return { agent, check, apply, reset };
}
