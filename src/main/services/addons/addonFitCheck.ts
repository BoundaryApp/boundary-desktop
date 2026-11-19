import { assessAddonFit, type AddonFit, type AddonHostFacts } from '../../../shared/addonFit';
import type { AddonCatalogEntry, AddonId } from '../../../shared/types/addons';
import { getAssistantStackAccess, getAssistantStackLifecycle } from '../assistant/AssistantStackService';
import { installedAddonsHere } from './addonComposeState';
import { readAddonHostFacts } from './addonHostFacts';

const PS_TIMEOUT_MS = 30_000;

export interface AddonFitCheck {
  fit: AddonFit;
  facts: AddonHostFacts;
  /** The add-on's containers run for this project while the store says it isn't installed. */
  leftover: boolean;
  /** The store says the add-on is installed, the stack is up, and its server isn't running. */
  stopped: boolean;
}

export interface AddonFitCheckDeps {
  isInstalled(id: AddonId): boolean;
  /** With `leftover`, the add-on's own containers hold its port and memory. */
  readFacts(entry: AddonCatalogEntry, options: { leftover: boolean }): Promise<AddonHostFacts>;
  ps(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }>;
  /** The agent stack finished starting or attaching, so its add-ons should be up too. */
  stackReady(): boolean;
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

/** Services of the add-on that this project's `compose ps` lists as running. */
async function runningServices(
  entry: AddonCatalogEntry,
  deps: Pick<AddonFitCheckDeps, 'ps'>
): Promise<Set<string>> {
  const own = entry.ownServices ?? { profile: entry.profile, services: entry.services };
  const { stdout } = await deps.ps(['--profile', own.profile, 'ps', '--format', 'json', ...own.services], addonInstallEnv(entry));
  const services = new Set(own.services);
  const running = new Set<string>();
  for (const row of parseComposePsRows(stdout)) {
    const service = String(psRowService(row));
    if (services.has(service)) running.add(service);
  }
  return running;
}

/**
 * `leftover`: a container of the add-on runs while the store says it isn't installed (a quit
 * or crash mid-install, a relaunch before Undo, or a Turn off whose stop or rm failed).
 * `stopped`: the store says it's installed and the stack is ready, but its server isn't
 * running (a local stack brought up by its own `make up` without the add-on's profile, or a
 * server that exited). `compose ps` without `-a` lists running containers only. A failed
 * `ps` reads as neither, so an engine that's down raises no alarm.
 */
async function containerState(
  entry: AddonCatalogEntry,
  deps: Pick<AddonFitCheckDeps, 'isInstalled' | 'ps' | 'stackReady'>
): Promise<{ leftover: boolean; stopped: boolean }> {
  const installed = deps.isInstalled(entry.id);
  if (installed && !deps.stackReady()) return { leftover: false, stopped: false };
  let running: Set<string>;
  try {
    running = await runningServices(entry, deps);
  } catch {
    return { leftover: false, stopped: false };
  }
  if (!installed) return { leftover: running.size > 0, stopped: false };
  return { leftover: false, stopped: !running.has(addonServerService(entry)) };
}

/** The service whose health says the add-on answers: its first `-server` service, else its first. */
function addonServerService(entry: AddonCatalogEntry): string {
  const services = entry.ownServices?.services ?? entry.services;
  return services.find((s) => s.endsWith('-server')) ?? services[0]!;
}

/**
 * The fit the listing shows and install checks. With leftover containers the port counts as
 * free and their memory isn't counted as used, since installing again reuses them.
 */
export async function checkAddonFit(
  entry: AddonCatalogEntry,
  deps: AddonFitCheckDeps = defaultAddonFitCheckDeps()
): Promise<AddonFitCheck> {
  const { leftover, stopped } = await containerState(entry, deps);
  const facts = await deps.readFacts(entry, { leftover });
  return { fit: assessAddonFit(entry, facts), facts, leftover, stopped };
}

function defaultAddonFitCheckDeps(): AddonFitCheckDeps {
  return {
    isInstalled: (id) => installedAddonsHere().includes(id),
    readFacts: (entry, options) => readAddonHostFacts(entry, undefined, options),
    ps: (args, env) => getAssistantStackAccess().compose(args, { env, timeout: PS_TIMEOUT_MS }),
    stackReady: () => getAssistantStackLifecycle().phase === 'ready',
  };
}
