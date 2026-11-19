import { useEffect, useReducer } from 'react';
import type { Ring } from '../../../../shared/calls/callRing';
import { getCallService, type Call, type CallService, type Missed } from './callService';

/**
 * The whole call service's state, for screens that aren't one Circle's: this window's call, the
 * calls ringing for this user, the rings they are answering and the last call that went
 * unanswered. Re-renders on any change.
 */
export function useCallService(): {
  call: Call | null;
  rings: Ring[];
  answering: Ring[];
  missed: Missed | null;
  service: CallService;
} {
  const service = getCallService();
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => service.onChange(render), [service]);
  return { call: service.current, rings: service.rings, answering: service.answeringRings, missed: service.missed, service };
}
