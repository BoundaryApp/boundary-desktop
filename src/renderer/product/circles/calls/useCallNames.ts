import { useMemo } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import { useCirclesState } from '../useCircles';

export interface CallNames {
  /** A member's name in a Circle, or "Someone" for an identity the Circle doesn't list. */
  person(circleKey: string, identity: string): string;
  /** A Circle's name, or "A Circle" for one this device doesn't have. */
  circle(circleKey: string): string;
}

/** Names for calls on any screen, from this user's Circles. */
export function useCallNames(): CallNames {
  const state = useCirclesState();
  return useMemo(() => {
    const byKey = new Map<string, CircleSnapshot>(state.snapshot.circles.map((circle) => [circle.key, circle]));
    return {
      person: (circleKey, identity) =>
        byKey.get(circleKey)?.members.find((member) => member.identity === identity)?.name || 'Someone',
      circle: (circleKey) => byKey.get(circleKey)?.name || 'A Circle',
    };
  }, [state]);
}
