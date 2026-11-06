import { assessAddonFit, type AddonFit, type AddonHostFacts } from '../../../shared/addonFit';
import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { installedAddonsHere } from './addonComposeState';
import { readAddonHostFacts } from './addonHostFacts';

const PS_TIMEOUT_MS = 30_000;

export interface AddonFitCheck {
  fit: AddonFit;
  facts: AddonHostFacts;
  /** The add-on's containers run for this project while the store says it isn't installed. */
  leftover: boolean;
}

export interface AddonFitCheckDeps {
  isInstalled(id: AddonId): boolean;
  /** With `leftover`, the add-on's own containers hold its port and memory. */
  readFacts(entry: AddonCatalogEntry, options: { leftover: boolean }): Promise<AddonHostFacts>;
  ps(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
}

/**
 * Before the store says an add-on is installed, Boundary's compose env sets its flags to 0
 * (and local-stack compose sets none). Every install-time call passes them as '1'.
 */
export function addonInstallEnv(entry: AddonCatalogEntry): Record<string, string> {
  return Object.fromEntries(entry.flags.map((flag) => [flag, '1']));
}

/** Rows of `compose ps --format json`: one object per line (Compose 2.21+) or one array. */
export function parseComposePsRows(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const rows = JSON.parse(trimmed) as unknown;
      return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
    } catch {
      return [];
    }
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split('\n')) {
    try {
      const row = JSON.parse(line) as unknown;
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>);
    } catch {
      /* not a row */
    }
  }
  return rows;
}

export const psRowService = (row: Record<string, unknown>): unknown => row.Service ?? row.service;

/**
 * True when this project's `compose ps` lists a running container of one of the add-on's
 * services while the store says the add-on isn't installed: a quit or crash mid-install, a
 * relaunch before Undo, or a Turn off whose stop or rm failed. A failed `ps` reads as none.
 */
async function hasLeftoverContainers(
  entry: AddonCatalogEntry,
  deps: Pick<AddonFitCheckDeps, 'isInstalled' | 'ps'>
): Promise<boolean> {
  if (deps.isInstalled(entry.id)) return false;
  try {
    const { stdout } = await deps.ps(
      ['--profile', entry.profile, 'ps', '--format', 'json', ...entry.services],
      addonInstallEnv(entry)
    );
    const services = new Set(entry.services);
    return parseComposePsRows(stdout).some((row) => services.has(String(psRowService(row))));
  } catch {
    return false;
  }
}

/**
 * The fit the listing shows and install checks. With leftover containers the port counts as
 * free and their memory isn't counted as used, since installing again reuses them.
 */
export async function checkAddonFit(
  entry: AddonCatalogEntry,
  deps: AddonFitCheckDeps = defaultAddonFitCheckDeps()
): Promise<AddonFitCheck> {
  const leftover = await hasLeftoverContainers(entry, deps);
  const facts = await deps.readFacts(entry, { leftover });
  return { fit: assessAddonFit(entry, facts), facts, leftover };
}

function defaultAddonFitCheckDeps(): AddonFitCheckDeps {
  return {
    isInstalled: (id) => installedAddonsHere().includes(id),
    readFacts: (entry, options) => readAddonHostFacts(entry, undefined, options),
    ps: (args, env) => getAssistantStackAccess().compose(args, { env, timeout: PS_TIMEOUT_MS }),
  };
}
