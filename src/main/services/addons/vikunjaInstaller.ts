import type { AddonStepId } from '../../../shared/types/addons';
import { VIKUNJA_ENTRY } from './addonCatalog';
import { readVikunjaEnabled, type VikunjaService } from './vikunjaAddon';
import { SCRIPT_STEP_OF, createEnableRemoveInstaller, type EnableRemoveInstaller, type ScriptAddonDeps } from './scriptAddonInstaller';

// Get, Turn off, Turn on and Remove and delete data for Todo lists (stack 0.3.15), through
// `addon.sh`. `enable` registers the database schema (hook `prepare`), starts the containers,
// creates the account and the agents' tokens (hook `init`) and reloads Hermes, so nothing
// restarts the assistant. Agents' profiles get the token afterwards (`afterEnable`) and lose it
// when it turns off or is removed (`afterDisable`).

/** The hooks `enable vikunja` runs, on top of the shared steps. */
const VIKUNJA_STEP_OF: Record<string, AddonStepId> = { ...SCRIPT_STEP_OF, prepare: 'start', init: 'setup' };

export interface VikunjaInstallerDeps extends ScriptAddonDeps<VikunjaService> {
  /** After `enable` worked: give agents' profiles what the new `todos` entry needs. Never throws. */
  afterEnable(): Promise<void>;
  /** After `disable` or a removal worked: take the token back from agents' profiles. Never throws. */
  afterDisable(): Promise<void>;
}

export type VikunjaInstaller = EnableRemoveInstaller;

export function createVikunjaInstaller(deps: VikunjaInstallerDeps): VikunjaInstaller {
  return createEnableRemoveInstaller({
    id: 'vikunja',
    name: VIKUNJA_ENTRY.name,
    stepOf: VIKUNJA_STEP_OF,
    deps,
    isEnabled: () => readVikunjaEnabled(deps.paths().root),
    afterEnable: deps.afterEnable,
    afterDisable: deps.afterDisable,
  });
}
