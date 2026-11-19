import { useSyncExternalStore } from 'react';
import { AGENT_BUTTON_CORNERS } from '../../../shared/types/desktopAgent';

/**
 * Where the agent button sits (agent window spec decision 3): an edge of the content area and a
 * place along it, from 0 (left or top end) to 1 (right or bottom end). Stored as a proportion so
 * the button lands in the same place at any window size. Kept in this window's storage, so it is
 * per Mac and never leaves it.
 */
export type AgentButtonEdge = 'top' | 'right' | 'bottom' | 'left';

export interface AgentButtonSpot {
  edge: AgentButtonEdge;
  along: number;
}

/** The button's side, in CSS pixels. */
export const BUTTON_SIZE = 60;
/** The gap between the button and the edge it sits on. */
const EDGE_INSET = 16;
/** The top edge sits below the title bar band, which takes window drags. */
const TOP_INSET = 52;

export const CORNERS = AGENT_BUTTON_CORNERS satisfies Record<string, AgentButtonSpot>;

export const DEFAULT_SPOT: AgentButtonSpot = CORNERS['Bottom right'];

const STORAGE_KEY = 'boundary:agent-button';
const EDGES: readonly AgentButtonEdge[] = ['top', 'right', 'bottom', 'left'];

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function readStored(): AgentButtonSpot {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AgentButtonSpot> | null;
    if (parsed && EDGES.includes(parsed.edge as AgentButtonEdge) && typeof parsed.along === 'number' && Number.isFinite(parsed.along)) {
      return { edge: parsed.edge as AgentButtonEdge, along: clamp(parsed.along) };
    }
  } catch {
    // Unreadable storage falls back to the default spot.
  }
  return DEFAULT_SPOT;
}

let spot: AgentButtonSpot | null = null;
const listeners = new Set<() => void>();

function current(): AgentButtonSpot {
  spot ??= readStored();
  return spot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentButtonSpot(): AgentButtonSpot {
  return useSyncExternalStore(subscribe, current);
}

export function saveAgentButtonSpot(next: AgentButtonSpot): void {
  spot = { edge: next.edge, along: clamp(next.along) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(spot));
  } catch {
    // Storage can be unavailable; the spot still holds for this session.
  }
  for (const listener of listeners) listener();
}

/** Whether the button sits in the bottom right corner, where composers keep room for it. */
export function isBottomRight(at: AgentButtonSpot): boolean {
  return (at.edge === 'bottom' || at.edge === 'right') && at.along === 1;
}

/** The button's CSS position inside a positioned content area. */
export function spotStyle(at: AgentButtonSpot): Record<string, string> {
  const across = (start: number) => `calc(${start}px + ${at.along} * (100% - ${start + EDGE_INSET + BUTTON_SIZE}px))`;
  switch (at.edge) {
    case 'top':
      return { top: `${TOP_INSET}px`, left: across(EDGE_INSET) };
    case 'bottom':
      return { bottom: `${EDGE_INSET}px`, left: across(EDGE_INSET) };
    case 'left':
      return { left: `${EDGE_INSET}px`, top: across(TOP_INSET) };
    case 'right':
      return { right: `${EDGE_INSET}px`, top: across(TOP_INSET) };
  }
}

/**
 * The spot a dragged button snaps to: the edge nearest its centre, at the matching place along
 * that edge. `x` and `y` are the centre, relative to the content area's top left.
 */
export function nearestSpot(x: number, y: number, width: number, height: number): AgentButtonSpot {
  const distances: Record<AgentButtonEdge, number> = { top: y, right: width - x, bottom: height - y, left: x };
  const edge = EDGES.reduce((best, next) => (distances[next] < distances[best] ? next : best));
  const half = BUTTON_SIZE / 2;
  const horizontal = (x - EDGE_INSET - half) / Math.max(1, width - 2 * EDGE_INSET - BUTTON_SIZE);
  const vertical = (y - TOP_INSET - half) / Math.max(1, height - TOP_INSET - EDGE_INSET - BUTTON_SIZE);
  const along = clamp(edge === 'top' || edge === 'bottom' ? horizontal : vertical);
  // Close to an end is the corner, so a button dropped there counts as in it.
  return { edge, along: along < 0.04 ? 0 : along > 0.96 ? 1 : along };
}

/** For tests: drop the in-memory spot so the next read comes from storage. */
export function resetAgentButtonSpotForTests(): void {
  spot = null;
}
