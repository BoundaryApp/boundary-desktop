import { getAssistantRootOverride } from './AssistantStackStore';
import { resolveAssistantProjectRoot } from './assistantPaths';
import { canonicalPath } from '../hostPaths';
import { APP_NAME } from '../../../shared/buildIdentity';

/** Which setting named the stack root. `managed` means neither did. */
export type StackRootSource = 'BOUNDARY_ASSISTANT_ROOT' | 'stored-override' | 'managed';

/**
 * The stack this session talks to. Every "is this a local stack?" question reads this one
 * descriptor, so provisioning, stop, reset, profile cleanup and the agent records agree.
 */
export interface StackMode {
  /**
   * `local` when BOUNDARY_ASSISTANT_ROOT or the stored override names a stack other than the
   * managed install, even one that fails validation, so a broken local root never falls
   * through to the managed stack. An override that names the managed install is `managed`.
   */
  kind: 'managed' | 'local';
  /** Canonical path of the stack's compose directory. Not checked for docker-compose.yml. */
  root: string;
  /** BOUNDARY_ASSISTANT_ROOT wins over the stored override (as in resolveAssistantRoot). */
  source: StackRootSource;
  /**
   * Attach to a stack already answering on the default ports (a developer's `make up`)
   * instead of starting one. Set by BOUNDARY_LOCAL_STACK=1 (`bun run dev:local-stack`), and
   * only for a local stack: the flag on its own leaves Boundary on the managed install.
   */
  attachLive: boolean;
}

let cached: { inputs: string; mode: StackMode } | null = null;

export function stackMode(): StackMode {
  const fromEnv = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() ?? '';
  const fromStore = getAssistantRootOverride() ?? '';
  const liveFlag = process.env.BOUNDARY_LOCAL_STACK?.trim() === '1';
  const inputs = `${fromEnv}\0${fromStore}\0${liveFlag ? '1' : ''}`;
  if (cached?.inputs === inputs) return cached.mode;

  const managed = canonicalPath(resolveAssistantProjectRoot());
  const raw = fromEnv || fromStore;
  const root = raw ? canonicalPath(raw) : managed;
  const kind = root === managed ? 'managed' : 'local';
  const mode: StackMode = {
    kind,
    root,
    source: fromEnv ? 'BOUNDARY_ASSISTANT_ROOT' : fromStore ? 'stored-override' : 'managed',
    attachLive: kind === 'local' && liveFlag,
  };
  cached = { inputs, mode };
  return mode;
}

/** Shorthand for `stackMode().kind === 'local'`. */
export function isLocalAssistantStackMode(): boolean {
  return stackMode().kind === 'local';
}

export function resetStackModeCacheForTests(): void {
  cached = null;
}

export function localStackStopSkippedMessage(): string {
  return (
    'Local assistant stack mode: leaving the live stack running ' +
    `(${APP_NAME} will not compose down or prune volumes).`
  );
}
