import crypto from 'node:crypto';
import { resetStackModeCacheForTests, stackMode } from './localStackMode';

/**
 * Which agent stack this session talks to. Boundary's own Hermes records (agents, DMs,
 * channels, session ownership) only make sense against the stack that minted them, so
 * they are kept per stack and never mixed between a local checkout and the managed install.
 */
export type AssistantStackIdentity =
  | { kind: 'managed'; root: string }
  | { kind: 'local'; root: string };

/** The kind and root of {@link stackMode}. */
export function activeAssistantStackIdentity(): AssistantStackIdentity {
  const { kind, root } = stackMode();
  return { kind, root };
}

/** electron-store name for the Hermes agent records of one stack. */
export function hermesAgentsStoreName(identity: AssistantStackIdentity): string {
  if (identity.kind === 'managed') return 'hermes-agents-managed';
  const hash = crypto.createHash('sha256').update(identity.root).digest('hex').slice(0, 12);
  return `hermes-agents-local-${hash}`;
}

export function resetAssistantStackIdentityCacheForTests(): void {
  resetStackModeCacheForTests();
}
