import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import { BUILTIN_AGENT_FALLBACK } from '../../shared/hermesAgentIdentity';
import type { AgentProfile, ChannelPostRecord, SessionInferenceOverride } from '../../shared/types/hermesChat';
import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import { BUILTIN_ASSISTANT_SLUG } from '../../shared/types/hermesChat';
import {
  type AssistantStackIdentity,
  activeAssistantStackIdentity,
  hermesAgentsStoreName,
} from '../services/assistant/assistantStackIdentity';

/** Pre-split store: one file shared by every stack. Claimed by the first local stack. */
const LEGACY_HERMES_AGENTS_STORE = 'hermes-agents';
const LEGACY_HERMES_AGENTS_BACKUP = 'hermes-agents.pre-split';

/** The built-in agent's name before ADR 0023. */
const LEGACY_BUILTIN_NAME = 'Assistant';

/** The keys these migrations touch, as earlier versions stored them. */
export interface LegacyHermesAgentsStore {
  get(key: 'agents'): AgentProfile[] | undefined;
  get(key: 'standingDmByAgent'): Record<string, string | null> | undefined;
  get(key: 'pendingChannelMessages'): Record<string, string[]> | undefined;
  get(key: 'channelPosts'): Record<string, ChannelPostRecord[]> | undefined;
  get(key: 'sessionMeta'): Record<string, { inference?: SessionInferenceOverride }> | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

function storeDir(): string {
  return app.getPath('userData');
}

function legacyStorePresent(dir: string): boolean {
  return fs.existsSync(path.join(dir, `${LEGACY_HERMES_AGENTS_STORE}.json`));
}

/**
 * Hand the pre-split store to a local stack: it was written while developing against the
 * local checkout. Moves `hermes-agents.json` to the stack's store (keeping a backup) only
 * when that store does not exist yet. The managed stack never claims it and starts empty.
 */
export function claimLegacyHermesAgentsStore(
  identity: AssistantStackIdentity,
  dir: string
): boolean {
  if (identity.kind !== 'local') return false;
  const legacy = path.join(dir, `${LEGACY_HERMES_AGENTS_STORE}.json`);
  const target = path.join(dir, `${hermesAgentsStoreName(identity)}.json`);
  if (!fs.existsSync(legacy) || fs.existsSync(target)) return false;
  fs.copyFileSync(legacy, path.join(dir, `${LEGACY_HERMES_AGENTS_BACKUP}.json`));
  fs.renameSync(legacy, target);
  return true;
}

/**
 * Claim for the stack this session talks to (it doesn't change while the app runs). Not
 * finished while the pre-split file is left: a later start against another local stack may
 * still claim it, as opening that stack's store did before.
 */
export function claimLegacyStoreForActiveStack(dir = storeDir()): boolean {
  claimLegacyHermesAgentsStore(activeAssistantStackIdentity(), dir);
  return !legacyStorePresent(dir);
}

function changeStackStores(change: (store: LegacyHermesAgentsStore) => void, dir: string): void {
  const names = fs
    .readdirSync(dir)
    .filter((file) => /^hermes-agents-.+\.json$/.test(file))
    .map((file) => file.slice(0, -'.json'.length));
  for (const name of names) {
    change(new Store({ name, cwd: dir }) as unknown as LegacyHermesAgentsStore);
  }
}

/**
 * Apply `change` to every per-stack store file. Waits while the pre-split file is
 * unclaimed, so the store that later claims it is changed too.
 */
function changeEveryStore(
  change: (store: LegacyHermesAgentsStore) => void,
  dir = storeDir()
): boolean {
  if (legacyStorePresent(dir)) return false;
  changeStackStores(change, dir);
  return true;
}

/** Channel lines kept under `pendingChannelMessages` (deprecated 2026-09-23) become posts. */
export function movePendingChannelMessages(store: LegacyHermesAgentsStore): void {
  const pending = store.get('pendingChannelMessages');
  if (pending === undefined) return;
  const posts = { ...(store.get('channelPosts') ?? {}) };
  let changed = false;
  for (const [sessionId, lines] of Object.entries(pending)) {
    if (!lines?.length || posts[sessionId]?.length) continue;
    posts[sessionId] = lines.map((content, index) => ({
      id: `pending:${sessionId}:${index}`,
      content,
      createdAt: new Date(0).toISOString(),
      delivery: 'posted' as const,
    }));
    changed = true;
  }
  if (changed) store.set('channelPosts', posts);
  store.delete('pendingChannelMessages');
}

/** ADR 0023: the built-in was "Assistant" before. Renames only an untouched record. */
export function renameLegacyBuiltin(store: LegacyHermesAgentsStore): void {
  const agents = store.get('agents') ?? [];
  const stored = agents.find((a) => a.slug === BUILTIN_ASSISTANT_SLUG);
  if (stored?.displayName !== LEGACY_BUILTIN_NAME || stored.handle !== LEGACY_BUILTIN_NAME) return;
  store.set(
    'agents',
    agents.map((a) =>
      a.slug === BUILTIN_ASSISTANT_SLUG
        ? { ...BUILTIN_AGENT_FALLBACK, createdAt: a.createdAt || BUILTIN_AGENT_FALLBACK.createdAt }
        : a
    )
  );
}

/** ADR 0023: the built-in has chats, not a standing DM. Drops its pre-0023 entry. */
export function dropBuiltinStandingDm(store: LegacyHermesAgentsStore): void {
  const map = { ...(store.get('standingDmByAgent') ?? {}) };
  if (!(BUILTIN_ASSISTANT_SLUG in map)) return;
  delete map[BUILTIN_ASSISTANT_SLUG];
  store.set('standingDmByAgent', map);
}

/** Removes fallbacks that `isGone` matches from each chat's override. */
export function dropChatFallbacks(
  store: LegacyHermesAgentsStore,
  isGone: (entry: InferenceChainEntry) => boolean
): void {
  const meta = { ...(store.get('sessionMeta') ?? {}) };
  let changed = false;
  for (const [id, row] of Object.entries(meta)) {
    const fallbacks = row.inference?.fallbacks;
    if (!row.inference || !fallbacks?.some(isGone)) continue;
    const { fallbacks: _drop, ...inference } = row.inference;
    const kept = fallbacks.filter((entry) => !isGone(entry));
    meta[id] = { ...row, inference: { ...inference, ...(kept.length ? { fallbacks: kept } : {}) } };
    changed = true;
  }
  if (changed) store.set('sessionMeta', meta);
}

/**
 * Chains came after the split, so the pre-split file holds none. Not waiting for it matters: a
 * run that repeated at a later start would also clear a Circle the user left (ADR 0036 §5).
 */
export const dropChatFallbacksInEveryStore = (
  isGone: (entry: InferenceChainEntry) => boolean,
  dir = storeDir()
) => changeStackStores((store) => dropChatFallbacks(store, isGone), dir);

export const movePendingChannelMessagesInEveryStore = (dir?: string) =>
  changeEveryStore(movePendingChannelMessages, dir);
export const renameLegacyBuiltinInEveryStore = (dir?: string) =>
  changeEveryStore(renameLegacyBuiltin, dir);
export const dropBuiltinStandingDmInEveryStore = (dir?: string) =>
  changeEveryStore(dropBuiltinStandingDm, dir);
