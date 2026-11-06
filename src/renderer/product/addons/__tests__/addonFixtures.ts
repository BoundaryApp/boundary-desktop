import { vi } from 'vitest';
import { assessAddonFit, type AddonHostFacts } from '../../../../shared/addonFit';
import type {
  AddonCatalogEntry,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
  AddonStepId,
} from '../../../../shared/types/addons';
import type { RunningWorkItem } from '../../../../shared/types/updates';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';

/** The catalog's Twenty entry as main sends it (addonCatalog.ts). */
const twenty: AddonCatalogEntry = {
  id: 'twenty',
  name: 'Twenty CRM',
  summary: 'Contacts, companies and deals that your agents can look up and keep current.',
  version: '2.55.0',
  profile: 'crm',
  flags: ['TWENTY_LOCAL_ENABLED', 'TWENTY_MCP_ENABLED'],
  services: ['twenty-server', 'twenty-worker', 'twenty-db', 'twenty-redis'],
  reserveMiB: 2208,
  limitMiB: 2688,
  downloadBytes: 1_120_000_000,
  port: { envKey: 'TWENTY_PORT', default: 3000 },
  restartsHermes: true,
  account: { username: 'owner@crm.localhost' },
};

/** A 12 GiB engine with 6.8 GiB in use and plenty of disk. */
const roomy: AddonHostFacts = {
  engineMiB: 12288,
  usedMiB: 6963,
  hostMiB: 32768,
  diskFreeBytes: 61_000_000_000,
  portInUse: false,
  engineResizable: true,
};

export function listing(
  facts: Partial<AddonHostFacts> = {},
  installed = false,
  canRemoveData = true,
  leftover = false
): AddonListing {
  const all = { ...roomy, ...facts };
  return { entry: twenty, installed, canRemoveData, leftover, fit: assessAddonFit(twenty, all), facts: all };
}

const STEP_IDS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];

/** A snapshot in the installer's step order; steps before `at` are done. */
export function snapshot(
  at: AddonStepId,
  status: AddonStep['status'],
  extra: Partial<AddonInstallSnapshot> = {}
): AddonInstallSnapshot {
  const index = STEP_IDS.indexOf(at);
  return {
    id: 'twenty',
    steps: STEP_IDS.map((id, i) => ({
      id,
      status: i < index ? 'done' : i === index ? status : 'pending',
    })),
    done: false,
    ...extra,
  };
}

export interface AddonsFake {
  list: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  turnOff: ReturnType<typeof vi.fn>;
  removeData: ReturnType<typeof vi.fn>;
  runningWork: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
  /** Sends a snapshot as main's `addons:progress` would. */
  emit: (s: AddonInstallSnapshot) => void;
}

/** Stubs `window.electronAPI.addons` with answering fakes. */
export function stubAddons(
  listings: AddonListing[],
  options: { current?: AddonInstallSnapshot | null; work?: RunningWorkItem[] } = {}
): AddonsFake {
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();
  const ok = async () => ({ success: true });
  const fake = {
    list: vi.fn(async () => listings),
    snapshot: vi.fn(async () => options.current ?? null),
    install: vi.fn(ok),
    undo: vi.fn(ok),
    restart: vi.fn(ok),
    turnOff: vi.fn(ok),
    removeData: vi.fn(async () => ({ success: true, removed: [] })),
    runningWork: vi.fn(async () => options.work ?? []),
    onProgress: vi.fn((cb: (s: AddonInstallSnapshot) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  stubElectronAPI({ addons: fake });
  return { ...fake, emit: (s) => listeners.forEach((cb) => cb(s)) };
}

export const codingTask: RunningWorkItem = {
  id: 'task:1',
  kind: 'coding',
  title: 'Inbox cleanup',
  detail: 'Coding task',
};
