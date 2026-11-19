import { vi } from 'vitest';
import { assessAddonFit, type AddonHostFacts } from '../../../../shared/addonFit';
import type {
  ActualOverview,
  BitwardenOverview,
  EmailOverview,
  AddonCatalogEntry,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
  AddonStepId,
  TwentyWorkspace,
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

/** The catalog's Actual entry as main sends it (addonCatalog.ts). */
const actual: AddonCatalogEntry = {
  id: 'actual',
  name: 'Actual Budget',
  summary: 'Your budgets, which agents can look up and, if you allow it, change.',
  version: '26.11.0',
  profile: 'budget',
  flags: ['ACTUAL_LOCAL_ENABLED', 'ACTUAL_MCP_ENABLED'],
  services: ['actual-server', 'actual-mcp-rw', 'actual-mcp-ro'],
  reserveMiB: 640,
  limitMiB: 1024,
  downloadBytes: 600_000_000,
  port: { envKey: 'ACTUAL_PORT', default: 5006 },
  restartsHermes: false,
  account: null,
};

/** The catalog's Bitwarden entry as main sends it (addonCatalog.ts). */
const bitwarden: AddonCatalogEntry = {
  id: 'bitwarden',
  name: 'Bitwarden',
  summary: 'Sign in to websites with logins from one folder of your Bitwarden vault.',
  version: '1.0.0',
  profile: 'bitwarden',
  flags: ['BITWARDEN_ENABLED'],
  services: ['bitwarden-broker'],
  reserveMiB: 256,
  limitMiB: 512,
  downloadBytes: 300_000_000,
  port: null,
  restartsHermes: false,
  account: null,
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
  leftover = false,
  stopped = false
): AddonListing {
  const all = { ...roomy, ...facts };
  return { entry: twenty, installed, canRemoveData, leftover, stopped, fit: assessAddonFit(twenty, all), facts: all };
}

/** Actual's listing; `installed` means this Mac's server is on. */
export function actualListing(installed = false, canRemoveData = true): AddonListing {
  return { entry: actual, installed, canRemoveData, leftover: false, stopped: false, fit: assessAddonFit(actual, roomy), facts: roomy };
}

/** Bitwarden's listing; `installed` means `BITWARDEN_ENABLED` is 1. */
export function bitwardenListing(installed = false, canRemoveData = true): AddonListing {
  return { entry: bitwarden, installed, canRemoveData, leftover: false, stopped: false, fit: assessAddonFit(bitwarden, roomy), facts: roomy };
}

/** The catalog's Email entry as main sends it (addonCatalog.ts). */
const email: AddonCatalogEntry = {
  id: 'email',
  name: 'Email',
  summary: 'Mail from your IMAP accounts that agents can search and read. They can’t send.',
  version: '1.0.0',
  profile: 'email',
  flags: ['EMAIL_ENABLED', 'EMAIL_DRAFTS_ENABLED'],
  services: ['email-mcp', 'email-indexer', 'email-drafts-mcp', 'email-outbox'],
  ownServices: { profile: 'email', services: ['email-mcp', 'email-indexer'] },
  reserveMiB: 384,
  limitMiB: 768,
  downloadBytes: 300_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

/** Email's listing; `installed` means `EMAIL_ENABLED` is 1. */
export function emailListing(installed = false, canRemoveData = true): AddonListing {
  return { entry: email, installed, canRemoveData, leftover: false, stopped: false, fit: assessAddonFit(email, roomy), facts: roomy };
}

/** The catalog's Todo lists entry as main sends it (addonCatalog.ts). */
const vikunja: AddonCatalogEntry = {
  id: 'vikunja',
  name: 'Todo lists',
  summary: 'Todo lists you and your agents both edit, with a web app on this Mac.',
  version: '2.8.0',
  profile: 'todo',
  flags: ['VIKUNJA_MCP_ENABLED'],
  services: ['vikunja', 'vikunja-proxy'],
  reserveMiB: 192,
  limitMiB: 384,
  downloadBytes: 300_000_000,
  port: { envKey: 'VIKUNJA_PORT', default: 3456 },
  restartsHermes: false,
  account: null,
};

/** Todo lists' listing; `installed` means `VIKUNJA_MCP_ENABLED` is 1, `dataLeft` that its files folder exists. */
export function vikunjaListing(installed = false, dataLeft = false): AddonListing {
  return {
    entry: vikunja,
    installed,
    canRemoveData: true,
    leftover: false,
    stopped: false,
    dataLeft,
    fit: assessAddonFit(vikunja, roomy),
    facts: roomy,
  };
}

/** The catalog's n8n and LightRAG entries as main sends them (addonCatalog.ts). */
const n8n: AddonCatalogEntry = {
  id: 'n8n',
  name: 'n8n',
  summary: 'Workflows that run on a schedule or a webhook, with starter workflows for research.',
  version: '2.47.4',
  profile: 'automation',
  flags: ['AUTOMATION_ENABLED'],
  services: ['n8n', 'gpt-researcher'],
  reserveMiB: 1024,
  limitMiB: 2048,
  downloadBytes: 1_500_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

const lightrag: AddonCatalogEntry = {
  id: 'lightrag',
  name: 'LightRAG',
  summary: 'A knowledge graph over your documents, stored in Neo4j, so agents can answer from them.',
  version: '1.5.7',
  profile: 'rag',
  flags: ['LIGHTRAG_MCP_ENABLED'],
  services: ['lightrag', 'lightrag-mcp', 'neo4j'],
  reserveMiB: 3072,
  limitMiB: 4096,
  downloadBytes: 2_000_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

/** n8n's listing; `installed` means `AUTOMATION_ENABLED` is 1, `dataLeft` that its volume is still there. */
export function n8nListing(installed = false, dataLeft = false, canRemoveData = true): AddonListing {
  return { entry: n8n, installed, canRemoveData, leftover: false, stopped: false, dataLeft, fit: assessAddonFit(n8n, roomy), facts: roomy };
}

/** LightRAG's listing; `installed` means `LIGHTRAG_MCP_ENABLED` is 1. */
export function lightragListing(installed = false): AddonListing {
  return { entry: lightrag, installed, canRemoveData: true, leftover: false, stopped: false, fit: assessAddonFit(lightrag, roomy), facts: roomy };
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
    kind: 'install',
    steps: STEP_IDS.map((id, i) => ({
      id,
      status: i < index ? 'done' : i === index ? status : 'pending',
    })),
    done: false,
    ...extra,
  };
}

/** The local workspace as main reads it from `crm-main`'s file. */
export function localWorkspace(extra: Partial<TwentyWorkspace> = {}): TwentyWorkspace {
  return {
    slug: 'main',
    local: true,
    url: 'http://twenty-server:3000',
    workspaceUrl: '',
    access: 'write',
    skippedReason: null,
    hasReadKey: true,
    hasWriteKey: true,
    parked: false,
    ...extra,
  };
}

/** A hosted workspace named `crm-<slug>`. */
export function hostedWorkspace(slug = 'work', extra: Partial<TwentyWorkspace> = {}): TwentyWorkspace {
  return {
    slug,
    local: false,
    url: 'https://crm.example.com',
    workspaceUrl: 'https://acme.crm.example.com',
    access: 'write',
    skippedReason: null,
    hasReadKey: true,
    hasWriteKey: true,
    parked: false,
    ...extra,
  };
}

export interface TwentyFake {
  workspaces: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  setAccess: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  copyPassword: ReturnType<typeof vi.fn>;
}

export interface AddonsFake {
  twenty: TwentyFake;
  actual: Record<'overview' | 'refresh' | 'serverBudgets' | 'connect' | 'disconnect' | 'setAccess' | 'open' | 'copyPassword', ReturnType<typeof vi.fn>>;
  bitwarden: Record<'overview' | 'refresh' | 'connect' | 'disconnect' | 'unlock' | 'lock' | 'sync' | 'onChanged', ReturnType<typeof vi.fn>>;
  /** Sends an overview as main's `addons:bitwarden-changed` would. */
  emitBitwarden: (o: BitwardenOverview) => void;
  email: Record<
    | 'overview'
    | 'refresh'
    | 'saveAccount'
    | 'mailboxes'
    | 'setMailboxes'
    | 'cancelAccount'
    | 'removeAccount'
    | 'setSettings'
    | 'onChanged',
    ReturnType<typeof vi.fn>
  >;
  vikunja: Record<'open', ReturnType<typeof vi.fn>>;
  pending: ReturnType<typeof vi.fn>;
  applyPending: ReturnType<typeof vi.fn>;
  /** Sends the pending list as main's `addons:pending-changed` would. */
  emitPending: (list: string[]) => void;
  list: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  turnOff: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  runningWork: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
  /** Sends a snapshot as main's `addons:progress` would. */
  emit: (s: AddonInstallSnapshot) => void;
}

/** Stubs `window.electronAPI.addons` with answering fakes. */
export function stubAddons(
  listings: AddonListing[],
  options: {
    current?: AddonInstallSnapshot | null;
    work?: RunningWorkItem[];
    workspaces?: TwentyWorkspace[];
    pending?: string[];
    actual?: ActualOverview;
    bitwarden?: BitwardenOverview;
    email?: EmailOverview;
  } = {}
): AddonsFake {
  const listeners = new Set<(s: AddonInstallSnapshot) => void>();
  const pendingListeners = new Set<(list: string[]) => void>();
  const ok = async () => ({ success: true });
  const twenty = {
    workspaces: vi.fn(async () => options.workspaces ?? []),
    connect: vi.fn(async () => ({ success: true, result: { ok: true, checks: [] } })),
    disconnect: vi.fn(ok),
    setAccess: vi.fn(ok),
    open: vi.fn(ok),
    copyPassword: vi.fn(ok),
  };
  const overview: ActualOverview = options.actual ?? {
    enabled: false,
    local: false,
    localSetUp: false,
    budgets: [],
    statusError: null,
  };
  const actual = {
    overview: vi.fn(async () => overview),
    refresh: vi.fn(async () => overview),
    serverBudgets: vi.fn(async () => ({ success: true, result: { ok: true, budgets: [] } })),
    connect: vi.fn(async () => ({ success: true, result: { ok: true, mcp: [] } })),
    disconnect: vi.fn(async () => ({ success: true, result: { ok: true } })),
    setAccess: vi.fn(async () => ({ success: true, result: { ok: true, mcp: [] } })),
    open: vi.fn(ok),
    copyPassword: vi.fn(ok),
  };
  const bitwardenListeners = new Set<(o: BitwardenOverview) => void>();
  const bitwardenOverview: BitwardenOverview = options.bitwarden ?? {
    enabled: false,
    accounts: [],
    requests: [],
    statusError: null,
    requestsError: null,
  };
  const bitwardenFake = {
    overview: vi.fn(async () => bitwardenOverview),
    refresh: vi.fn(async () => bitwardenOverview),
    connect: vi.fn(async () => ({ success: true, result: { ok: true, message: '' } })),
    disconnect: vi.fn(async () => ({ success: true, result: { ok: true, message: '' } })),
    unlock: vi.fn(async () => ({ success: true, result: { ok: true } })),
    lock: vi.fn(async () => ({ success: true, result: { ok: true } })),
    sync: vi.fn(async () => ({ success: true, result: { ok: true, synced: [], recent: false } })),
    onChanged: vi.fn((cb: (o: BitwardenOverview) => void) => {
      bitwardenListeners.add(cb);
      return () => bitwardenListeners.delete(cb);
    }),
  };
  const emailOverview: EmailOverview = options.email ?? {
    available: true,
    enabled: false,
    drafts: false,
    since: null,
    attachments: false,
    accounts: [],
    lastPass: null,
    passOwed: false,
    readError: null,
  };
  const emailFake = {
    overview: vi.fn(async () => emailOverview),
    refresh: vi.fn(async () => emailOverview),
    saveAccount: vi.fn(async () => ({ success: true, result: { ok: true } })),
    mailboxes: vi.fn(async () => ({ success: true, result: { ok: true, mailboxes: [] } })),
    setMailboxes: vi.fn(async () => ({ success: true, result: { ok: true } })),
    cancelAccount: vi.fn(ok),
    removeAccount: vi.fn(async () => ({ success: true, result: { ok: true } })),
    setSettings: vi.fn(async () => ({ success: true, result: { ok: true } })),
    onChanged: vi.fn((): (() => void) => () => undefined),
  };
  const fake = {
    list: vi.fn(async () => listings),
    email: emailFake,
    actual,
    bitwarden: bitwardenFake,
    vikunja: { open: vi.fn(ok) },
    snapshot: vi.fn(async () => options.current ?? null),
    install: vi.fn(ok),
    undo: vi.fn(ok),
    cancel: vi.fn(ok),
    restart: vi.fn(ok),
    turnOff: vi.fn(ok),
    start: vi.fn(ok),
    remove: vi.fn(ok),
    runningWork: vi.fn(async () => options.work ?? []),
    twenty,
    pending: vi.fn(async () => options.pending ?? []),
    applyPending: vi.fn(ok),
    onPendingChanged: vi.fn((cb: (list: string[]) => void) => {
      pendingListeners.add(cb);
      return () => pendingListeners.delete(cb);
    }),
    onProgress: vi.fn((cb: (s: AddonInstallSnapshot) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  stubElectronAPI({ addons: fake });
  return {
    ...fake,
    emit: (s) => listeners.forEach((cb) => cb(s)),
    emitPending: (list) => pendingListeners.forEach((cb) => cb(list)),
    emitBitwarden: (o) => bitwardenListeners.forEach((cb) => cb(o)),
  };
}

export const codingTask: RunningWorkItem = {
  id: 'task:1',
  kind: 'coding',
  title: 'Inbox cleanup',
  detail: 'Coding task',
};
