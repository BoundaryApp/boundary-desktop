import { getAssistantRootOverride } from './AssistantStackStore';

/**
 * True when Boundary is pointed at a developer checkout (sibling sovereign-agent-stack)
 * instead of the pinned userData install. Set by `bun run dev:local-stack` via
 * BOUNDARY_LOCAL_STACK=1 and BOUNDARY_ASSISTANT_ROOT.
 */
export function isLocalAssistantStackMode(): boolean {
  if (process.env.BOUNDARY_LOCAL_STACK?.trim() === '1') {
    return true;
  }
  if (process.env.BOUNDARY_ASSISTANT_ROOT?.trim()) {
    return true;
  }
  return Boolean(getAssistantRootOverride());
}

export function localStackResetBlockedMessage(action = 'Reset'): string {
  return (
    `${action} is disabled while using a local assistant stack ` +
    '(BOUNDARY_LOCAL_STACK / BOUNDARY_ASSISTANT_ROOT). ' +
    'Unset those and use the Boundary-managed userData install to reset.'
  );
}

export function localStackStopSkippedMessage(): string {
  return (
    'Local assistant stack mode: leaving the live stack running ' +
    '(Boundary will not compose down or prune volumes).'
  );
}
