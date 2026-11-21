import { readStackEnv } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';
import { enableAddon, flagOn, readStackFile, type AddonScriptLine, type AddonScriptOutcome } from './addonScript';
import { SCRIPT_STEP_OF, createEnableRemoveInstaller, type EnableRemoveInstaller, type ScriptAddonDeps } from './scriptAddonInstaller';
import { stackFilesAt } from '../stackHost/activeStack';
import { moveFlagsToEnv, type EnvMoveRecord } from './envFlagMove';

// n8n and LightRAG ship in the stack as built-in add-ons (CR 0020 R10, stack 0.3.13): each has an
// `addons/<id>/addon.json` with a `builtin` block naming the `.env` flag `addon.sh enable` and
// `disable` write. That flag is the only record of whether they're on. Until this, Boundary kept
// its own switch for each in its store and passed its own values to compose.

export type BuiltinAddonId = 'n8n' | 'lightrag';

export const BUILTIN_ADDON_IDS: readonly BuiltinAddonId[] = ['n8n', 'lightrag'];

/** The manifest's `builtin.flag` (addons/n8n/addon.json, addons/lightrag/addon.json at v0.3.14). */
const BUILTIN_FLAG: Record<BuiltinAddonId, string> = {
  n8n: 'AUTOMATION_ENABLED',
  lightrag: 'LIGHTRAG_MCP_ENABLED',
};

export function isBuiltinAddonId(id: unknown): id is BuiltinAddonId {
  return id === 'n8n' || id === 'lightrag';
}

/** The stack tree has `addon.sh` and the add-on's manifest with a `builtin` block naming its flag. */
export async function builtinAddonAvailable(files: StackFiles, id: BuiltinAddonId): Promise<boolean> {
  const manifest = await readStackFile(files, `addons/${id}/addon.json`);
  if (manifest === null || (await readStackFile(files, 'scripts/addon.sh')) === null) return false;
  try {
    const m = JSON.parse(manifest) as { builtin?: { flag?: unknown } };
    return m.builtin?.flag === BUILTIN_FLAG[id];
  } catch {
    return false;
  }
}

/** The add-on's flag in the stack's `.env`. */
export async function readBuiltinEnabled(files: StackFiles, id: BuiltinAddonId): Promise<boolean> {
  return flagOn((await readStackEnv(files, 'stack', '.env'))[BUILTIN_FLAG[id]]);
}

export interface MoveSwitchesDeps extends EnvMoveRecord {
  /** The old store switches. */
  stored(): Record<BuiltinAddonId, boolean>;
}

/**
 * Carries Boundary's old switches into the managed stack's `.env`, once per stack root, so the
 * flags `addon.sh` reads say what this Mac ran. Before this, Boundary passed `LIGHTRAG_MCP_ENABLED`
 * itself and started n8n by naming its services, so the `.env` values were stale: `setup.sh --rag`
 * from older Boundaries wrote `LIGHTRAG_MCP_ENABLED=1`, and `sync-profiles.sh` seeds
 * `AUTOMATION_ENABLED=1` when `automation` is in `.env`'s COMPOSE_PROFILES. After the move, a flag
 * missing from `.env` (a stack folder set up again) is written as 0, since both are off by
 * default in Boundary. Returns the flags it wrote; none when there's no `.env`. `root` keys the
 * once-only record.
 */
export function moveBuiltinSwitchesToEnv(
  files: StackFiles,
  root: string,
  deps: MoveSwitchesDeps
): Promise<Record<string, string>> {
  return moveFlagsToEnv(files, root, deps, (moved, current) => {
    const stored = deps.stored();
    const values: Record<string, string> = {};
    for (const id of BUILTIN_ADDON_IDS) {
      const flag = BUILTIN_FLAG[id];
      if (!moved) values[flag] = stored[id] ? '1' : '0';
      else if (!(flag in current)) values[flag] = '0';
    }
    return values;
  });
}

/**
 * Whether n8n's workflows are on this Mac while it's off: its `n8n_storage` volume exists in
 * Boundary's compose project. `remove n8n --delete-data` deletes it; `disable` keeps it. A failed
 * inspect, with the engine down, reads as no.
 */
export async function n8nDataLeft(inspect: (volume: string) => Promise<void>, project: string): Promise<boolean> {
  try {
    await inspect(`${project}_n8n_storage`);
    return true;
  } catch {
    return false;
  }
}

/** `enable` pulls images the first time: n8n's two, or LightRAG's two and Neo4j's. */
const ENABLE_TIMEOUT_MS = 1_800_000;

export interface BuiltinAddonService {
  /** `addon.sh enable <id> --json`, under the caller's lock. */
  enable(options?: { onLine?: (l: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
  /** Whether it's on, from the stack's `.env`. */
  refresh(): Promise<{ enabled: boolean }>;
}

export function createBuiltinAddonService(
  id: BuiltinAddonId,
  deps: Pick<ScriptAddonDeps<unknown>, 'paths' | 'run' | 'log'>
): BuiltinAddonService {
  return {
    enable: (options = {}) => enableAddon(deps, id, { timeoutMs: ENABLE_TIMEOUT_MS, onLine: options.onLine }),
    refresh: async () => ({ enabled: await readBuiltinEnabled(stackFilesAt(deps.paths().root), id) }),
  };
}

export interface BuiltinAddonInstallerDeps extends ScriptAddonDeps<BuiltinAddonService> {
  /** After `disable` worked. Never throws. */
  afterDisable(): Promise<void>;
}

export type BuiltinAddonInstaller = EnableRemoveInstaller;

export function createBuiltinAddonInstaller(
  id: BuiltinAddonId,
  name: string,
  deps: BuiltinAddonInstallerDeps
): BuiltinAddonInstaller {
  const installer = createEnableRemoveInstaller({
    id,
    name,
    stepOf: SCRIPT_STEP_OF,
    deps,
    isEnabled: () => readBuiltinEnabled(stackFilesAt(deps.paths().root), id),
    afterEnable: async () => {},
    afterDisable: deps.afterDisable,
  });
  // A failed Get may have started some services (LightRAG's Neo4j), so Undo cleans up as Turn off does.
  return {
    ...installer,
    undo: async () => {
      await installer.undo();
      await deps.afterDisable();
    },
  };
}
