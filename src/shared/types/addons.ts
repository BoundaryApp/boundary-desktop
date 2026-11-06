import type { AddonFit, AddonHostFacts } from '../addonFit';

/** Add-ons this build knows. A store or IPC call can carry an id from another build. */
export const ADDON_IDS = ['twenty'] as const;

export type AddonId = (typeof ADDON_IDS)[number];

export function isAddonId(value: unknown): value is AddonId {
  return typeof value === 'string' && (ADDON_IDS as readonly string[]).includes(value);
}

export interface AddonCatalogEntry {
  id: AddonId;
  name: string;
  summary: string;
  version: string;
  /** Compose profile the add-on's services belong to. */
  profile: string;
  /** Stack `.env` flags that turn the add-on on. */
  flags: string[];
  services: string[];
  reserveMiB: number;
  limitMiB: number;
  downloadBytes: number;
  port: { envKey: string; default: number } | null;
  restartsHermes: boolean;
  account: { username: string } | null;
}

export type AddonStepId = 'check' | 'download' | 'start' | 'answer' | 'setup' | 'restart';

export interface AddonStep {
  id: AddonStepId;
  status: 'pending' | 'running' | 'done' | 'error' | 'waiting';
  detail?: string;
  bytes?: { done: number; total: number };
}

export interface AddonInstallSnapshot {
  id: AddonId;
  steps: AddonStep[];
  error?: { step: AddonStepId; message: string; logTail: string[] };
  done: boolean;
}

/** Why Remove and delete data is unavailable when Boundary runs the developer's own stack checkout. */
export const ADDON_LOCAL_REMOVE_MESSAGE =
  "Remove Twenty's data from the stack checkout instead; Boundary doesn't delete files in a local stack.";

export interface AddonListing {
  entry: AddonCatalogEntry;
  installed: boolean;
  /** False in local stack mode, where the installer refuses to delete files. */
  canRemoveData: boolean;
  /**
   * The add-on's containers run for this stack while it isn't recorded as installed: an
   * install that didn't finish, or a Turn off whose stop or rm failed. `fit` then counts
   * the port as free and leaves those containers' memory out of `facts.usedMiB`.
   */
  leftover: boolean;
  fit: AddonFit;
  facts: AddonHostFacts;
}
