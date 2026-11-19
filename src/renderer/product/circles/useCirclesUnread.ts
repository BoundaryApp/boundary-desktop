import { useCirclesState } from './useCircles';
import { circleMentioned, circleUnread, useCircleChannels } from './useCircleChat';
import { useDirectUnread } from './useDirectChat';

/**
 * Unread Circle messages across every Circle, and whether any mention the user (ADR 0052 §5).
 * The Circles icon, the app icon's badge and the desktop agent button show it.
 */
export function useCirclesUnread(): { total: number; mentioned: boolean } {
  const state = useCirclesState();
  const keys = state.status === 'running' ? state.snapshot.circles.map((circle) => circle.key) : [];
  const channels = useCircleChannels(keys);
  const direct = useDirectUnread(keys);
  const total = keys.reduce((sum, key) => sum + circleUnread(channels[key]) + (direct[key] ?? 0), 0);
  const mentioned = keys.some((key) => circleMentioned(channels[key]));
  return { total, mentioned };
}
