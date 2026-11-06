import type { AddonFit } from '../../../shared/addonFit';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
  AddonStepId,
} from '../../../shared/types/addons';

// Words and figures for the Add-ons screens (docs/addons-ux-study/prototype.html). Memory is
// in GiB, as the engine's size is set; downloads and disk are decimal GB, as Finder shows them.

/** One decimal: `2208` MiB → `2.2`. */
export const memGB = (mib: number): string => (Math.round((mib / 1024) * 10) / 10).toFixed(1);
export const bytesGB = (bytes: number): string => (Math.round(bytes / 1e8) / 10).toFixed(1);
/** Whole GB for engine sizes the user picks: `16384` → `16`. */
export const wholeGB = (mib: number): string => String(Math.round(mib / 1024));

/** What only the stack's docs say about an add-on, which the catalog doesn't carry. */
interface AddonFacts {
  /** "Open Twenty", "Sign in to Twenty". */
  shortName: string;
  tools: { lead: string; names: string[] } | null;
  setupDetail: string;
  tryAsking: string | null;
  /** The stack `.env` key holding the generated sign-in password, until Passwords & Logins does. */
  passwordEnvKey: string | null;
}

export const ADDON_FACTS: Record<AddonId, AddonFacts> = {
  twenty: {
    shortName: 'Twenty',
    // ../assistant docs/crm.md, "What Hermes sees" and the profile table.
    tools: {
      lead: 'Seven tools on your default and browser agents. Every record change goes through execute_tool.',
      names: ['execute_tool', 'get_tool_catalog', 'learn_tools', '4 more'],
    },
    setupDetail:
      'Database migrations, a workspace, the owner account, and a read-only and a read-write key for agents',
    tryAsking: 'Who did I meet from Acme last month?',
    passwordEnvKey: 'TWENTY_PASSWORD',
  },
};

/** The detail page's state, and the pill, while the add-on's containers run uninstalled. */
export const LEFTOVER_TITLE = 'Install didn’t finish';

export type PillTone = 'default' | 'brand' | 'ok' | 'warn' | 'destructive' | 'outline';

/** True while an install has started and not finished: running, failed or waiting to restart. */
export const inProgress = (s: AddonInstallSnapshot | null): s is AddonInstallSnapshot =>
  Boolean(s && !s.done);

const restartStep = (s: AddonInstallSnapshot) => s.steps.find((step) => step.id === 'restart');

export const waitingForRestart = (s: AddonInstallSnapshot | null): boolean =>
  Boolean(s && !s.error && restartStep(s)?.status === 'waiting');

export const engineDown = (listing: AddonListing): boolean => listing.facts.engineMiB === 0;

/** The card and detail pill: the install's state first, then installed, then the fit. */
export function addonPill(
  listing: AddonListing,
  install: AddonInstallSnapshot | null
): { tone: PillTone; label: string; dot?: boolean } {
  if (inProgress(install)) {
    if (install.error) return { tone: 'destructive', label: 'Install failed' };
    if (waitingForRestart(install)) return { tone: 'warn', label: 'Restart to finish', dot: true };
    return { tone: 'brand', label: 'Installing', dot: true };
  }
  if (listing.installed) return { tone: 'ok', label: 'On', dot: true };
  if (listing.leftover) return { tone: 'warn', label: LEFTOVER_TITLE };
  if (engineDown(listing)) return { tone: 'outline', label: 'Stack not running' };
  return fitPill(listing.fit);
}

function fitPill(fit: AddonFit): { tone: PillTone; label: string } {
  if (fit.memory === 'over') return { tone: 'destructive', label: 'Needs more memory' };
  if (fit.disk === 'over') return { tone: 'destructive', label: 'Needs more disk' };
  if (fit.port === 'over') return { tone: 'destructive', label: 'Port in use' };
  if (fit.verdict === 'tight') return { tone: 'warn', label: 'Fits, tight' };
  return { tone: 'default', label: 'Fits this Mac' };
}

export function stepName(entry: AddonCatalogEntry, id: AddonStepId): string {
  switch (id) {
    case 'check':
      return 'Checking this Mac';
    case 'download':
      return 'Downloading';
    case 'start':
      return `Starting ${entry.name}`;
    case 'answer':
      return 'Checking it answers';
    case 'setup':
      return 'First-time setup';
    case 'restart':
      return 'Restart the assistant';
  }
}

export function stepDetail(entry: AddonCatalogEntry, step: AddonStep): string {
  if (step.status === 'running' && step.detail) return step.detail;
  switch (step.id) {
    case 'check':
      return entry.port ? `Memory, disk, port ${entry.port.default}` : 'Memory and disk';
    case 'download':
      return entry.services.join(', ');
    case 'start':
      return `${entry.services.length} containers`;
    case 'answer':
      return entry.port ? `localhost:${entry.port.default}` : 'Health check';
    case 'setup':
      return ADDON_FACTS[entry.id].setupDetail;
    case 'restart':
      return 'So agents can use the new tools';
  }
}

/** Relative weight of each step in the overall bar, from the prototype. */
const STEP_WEIGHT: Record<AddonStepId, number> = {
  check: 4,
  download: 46,
  start: 12,
  answer: 6,
  setup: 18,
  restart: 6,
};

export function overallPercent(s: AddonInstallSnapshot): number {
  if (s.done) return 100;
  let total = 0;
  let done = 0;
  for (const step of s.steps) {
    const weight = STEP_WEIGHT[step.id];
    total += weight;
    if (step.status === 'done') done += weight;
    else if (step.status === 'running' && step.bytes && step.bytes.total > 0) {
      done += weight * Math.min(1, step.bytes.done / step.bytes.total);
    }
  }
  return total ? Math.round((done / total) * 100) : 0;
}
