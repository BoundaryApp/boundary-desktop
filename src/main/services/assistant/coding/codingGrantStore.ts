import path from 'node:path';
import Store from 'electron-store';
import type {
  CodingGrant,
  CodingGrantOrigin,
  CodingGrantState,
} from '../../../../shared/types/codingFolders';

/**
 * Coding grants (ADR 0028 §3). Each record has the host bridge's grant shape (ADR 0027 §7)
 * with coding fields beside it. This is its own store until the bridge's store is on main;
 * then the records move into the bridge's `grants` list unchanged.
 */

interface CodingGrantStoreShape {
  grants: CodingGrant[];
  /** Last verify result per folder; missing means not checked since it was granted. */
  states: Record<string, CodingGrantState>;
  /**
   * The coding roots Hermes had when it was last created. A grant outside these waits for
   * Hermes's next restart (ADR 0028 §4). Null until Boundary first records a Hermes start.
   */
  hermesRoots: string[] | null;
  /** `CODING_PATH_ALIASES` that opencode-mcp and Hermes last started with. */
  appliedAliases: string | null;
}

const store = new Store<CodingGrantStoreShape>({
  name: 'coding-grants',
  defaults: { grants: [], states: {}, hermesRoots: null, appliedAliases: null },
});

function key(hostPath: string): string {
  return path.resolve(hostPath);
}

export function listCodingGrantRecords(): CodingGrant[] {
  return store.get('grants') ?? [];
}

export function findCodingGrant(hostPath: string): CodingGrant | null {
  const wanted = key(hostPath);
  return listCodingGrantRecords().find((grant) => grant.resource === wanted) ?? null;
}

export function addCodingGrantRecord(input: {
  hostPath: string;
  projectId: string | null;
  origin: Exclude<CodingGrantOrigin, 'project-folder'>;
  createdByBoundary: boolean;
  now?: Date;
}): CodingGrant {
  const existing = findCodingGrant(input.hostPath);
  if (existing) return existing;
  const grant: CodingGrant = {
    capability: 'coding',
    resource: key(input.hostPath),
    createdAt: (input.now ?? new Date()).toISOString(),
    expiresAt: null,
    projectId: input.projectId,
    origin: input.origin,
    createdByBoundary: input.createdByBoundary,
  };
  store.set('grants', [...listCodingGrantRecords(), grant]);
  return grant;
}

export function removeCodingGrantRecord(hostPath: string): CodingGrant | null {
  const existing = findCodingGrant(hostPath);
  if (!existing) return null;
  store.set(
    'grants',
    listCodingGrantRecords().filter((grant) => grant.resource !== existing.resource)
  );
  const states = { ...(store.get('states') ?? {}) };
  delete states[existing.resource];
  store.set('states', states);
  return existing;
}

export function getCodingGrantStates(): Record<string, CodingGrantState> {
  return store.get('states') ?? {};
}

export function setCodingGrantState(hostPath: string, state: CodingGrantState): void {
  store.set('states', { ...getCodingGrantStates(), [key(hostPath)]: state });
}

/** Hermes was just created with these coding roots in its environment. */
export function recordHermesCodingRoots(roots: readonly string[]): void {
  store.set('hermesRoots', [...new Set(roots.map(key))].sort());
}

/** True when Hermes's own edits can't reach this folder until it restarts. */
export function isHermesPending(hostPath: string): boolean {
  const known = store.get('hermesRoots') ?? [];
  const wanted = key(hostPath);
  return !known.some((root) => wanted === root || wanted.startsWith(`${root}${path.sep}`));
}

export function getAppliedCodingAliases(): string | null {
  return store.get('appliedAliases') ?? null;
}

export function recordAppliedCodingAliases(aliases: string): void {
  store.set('appliedAliases', aliases);
}

/** Test-only. */
export function resetCodingGrantStoreForTests(): void {
  store.set('grants', []);
  store.set('states', {});
  store.set('hermesRoots', null);
  store.set('appliedAliases', null);
}
