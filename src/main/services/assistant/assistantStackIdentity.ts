import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAssistantRootOverride } from './AssistantStackStore';
import { resolveAssistantProjectRoot } from './assistantPaths';

/**
 * Which agent stack this session talks to. Boundary's own Hermes records (agents, DMs,
 * channels, session ownership) only make sense against the stack that minted them, so
 * they are kept per stack and never mixed between a local checkout and the managed install.
 */
export type AssistantStackIdentity =
  | { kind: 'managed'; root: string }
  | { kind: 'local'; root: string };

/** Pre-split store: one file shared by every stack. Claimed by the first local stack. */
export const LEGACY_HERMES_AGENTS_STORE = 'hermes-agents';
export const LEGACY_HERMES_AGENTS_BACKUP = 'hermes-agents.pre-split';

function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

let cached: { inputs: string; identity: AssistantStackIdentity } | null = null;

/**
 * Local when BOUNDARY_ASSISTANT_ROOT or the stored override names a stack other than the
 * managed install — even one that fails validation, so a broken local root never falls
 * through to the managed stack's records.
 */
export function activeAssistantStackIdentity(): AssistantStackIdentity {
  const fromEnv = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() ?? '';
  const fromStore = getAssistantRootOverride() ?? '';
  const inputs = `${fromEnv}\0${fromStore}`;
  if (cached?.inputs === inputs) return cached.identity;

  const managed = canonicalPath(resolveAssistantProjectRoot());
  const raw = fromEnv || fromStore;
  const root = raw ? canonicalPath(raw) : managed;
  const identity: AssistantStackIdentity =
    root === managed ? { kind: 'managed', root } : { kind: 'local', root };
  cached = { inputs, identity };
  return identity;
}

/** electron-store name for the Hermes agent records of one stack. */
export function hermesAgentsStoreName(identity: AssistantStackIdentity): string {
  if (identity.kind === 'managed') return 'hermes-agents-managed';
  const hash = crypto.createHash('sha256').update(identity.root).digest('hex').slice(0, 12);
  return `hermes-agents-local-${hash}`;
}

/**
 * Hand the pre-split store to a local stack: it was written while developing against the
 * local checkout. Moves `hermes-agents.json` to the stack's store (keeping a backup) only
 * when that store does not exist yet. The managed stack never claims it and starts empty.
 */
export function claimLegacyHermesAgentsStore(
  identity: AssistantStackIdentity,
  storeDir: string
): boolean {
  if (identity.kind !== 'local') return false;
  const legacy = path.join(storeDir, `${LEGACY_HERMES_AGENTS_STORE}.json`);
  const target = path.join(storeDir, `${hermesAgentsStoreName(identity)}.json`);
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return false;
  fs.copyFileSync(legacy, path.join(storeDir, `${LEGACY_HERMES_AGENTS_BACKUP}.json`));
  fs.renameSync(legacy, target);
  return true;
}

export function resetAssistantStackIdentityCacheForTests(): void {
  cached = null;
}
