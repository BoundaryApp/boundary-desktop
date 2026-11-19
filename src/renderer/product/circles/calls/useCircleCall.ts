import { useCallback, useEffect, useReducer } from 'react';
import { isPersonRoom } from '../../../../shared/calls/callRing';
import type { LiveRoom } from '../../../../shared/calls/callRooms';
import { getCallService, type Call, type JoinOptions } from './callService';

/**
 * The live rooms in one Circle and who is in each (calls with one person aren't the Circle's), this window's call when it's in that Circle,
 * and `join` for a room the caller names (Circle calls spec, "The public seam").
 */
export function useCircleCall(circleKey: string): {
  rooms: LiveRoom[];
  call: Call | null;
  join(room: string, options: JoinOptions): Promise<Call>;
} {
  const service = getCallService();
  const [, render] = useReducer((count: number) => count + 1, 0);
  useEffect(() => service.onChange(render), [service]);
  const join = useCallback((room: string, options: JoinOptions) => service.join(circleKey, room, options), [service, circleKey]);
  const call = service.current;
  const rooms = service.rooms.rooms(circleKey).filter((live) => !isPersonRoom(live.room));
  return { rooms, call: call?.circleKey === circleKey ? call : null, join };
}
