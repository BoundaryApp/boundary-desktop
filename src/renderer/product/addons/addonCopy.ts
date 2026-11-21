import type { AddonFit } from '../../../shared/addonFit';
import type {
  AddonCatalogEntry,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStep,
  AddonStepId,
  TwentyAccess,
  TwentyWorkspace,
} from '../../../shared/types/addons';

// Words and figures for the Add-ons screens (docs/addons-ux-study/prototype.html). Memory is
// in GiB, as the engine's size is set; downloads and disk are decimal GB, as Finder shows them.

/** The add-on store's name rule (ADDON_SLUG), as every connect sheet words it. */
export const ADDON_SLUG_RULE = 'Start the name with a letter, and use up to 31 lowercase letters, numbers and dashes.';

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
  /** What the finished install says in place of the agents' tools, for an add-on agents don't reach. */
  doneLine?: string;
}

export const ADDON_FACTS: Record<AddonId, AddonFacts> = {
  twenty: {
    shortName: 'Twenty',
    // ../assistant docs/crm.md, "What Hermes sees" and the profile table.
    tools: {
      lead: '7 tools per workspace. Every record change goes through execute_tool. Unattended runs, such as scheduled tasks, get the read-only key whatever you choose here.',
      names: ['execute_tool', 'get_tool_catalog', '5 more'],
    },
    setupDetail:
      'Database migrations, a workspace, the owner account, and a read-only and a read-write key for agents',
    tryAsking: 'Who did I meet from Acme last month?',
    passwordEnvKey: 'TWENTY_PASSWORD',
  },
  actual: {
    shortName: 'Actual',
    // ../assistant addons/actual/addon.json: 18 read tools, and 32 write tools with Make changes.
    tools: {
      lead: 'Per budget: 18 tools to look things up, and 32 more that make changes when you allow it. Unattended runs get only the read-only tools.',
      names: ['get-transactions', 'monthly-summary', 'budget-vs-actual', '15 more'],
    },
    setupDetail: 'A generated server password and a first budget',
    tryAsking: 'How much did I spend on groceries last month?',
    passwordEnvKey: null,
  },
  bitwarden: {
    shortName: 'Bitwarden',
    // ../assistant addons/bitwarden/addon.json, vaultBackend: logins reach the agent through
    // browser_vault, and these two tools ask for a login and hand one back.
    tools: {
      lead: 'The agent lists and fills logins from the folder through the browser’s vault tool, and never sees a password. Chats on the default and browser profiles get these; scheduled jobs and the API profile don’t.',
      names: ['bitwarden_request_access', 'bitwarden_release_access'],
    },
    setupDetail: 'The agents’ tools, without restarting the assistant',
    tryAsking: 'Sign in to my electricity account and download last month’s bill.',
    passwordEnvKey: null,
  },
  email: {
    shortName: 'Email',
    tools: null,
    setupDetail: 'The indexer reads the mailboxes you chose',
    tryAsking: 'What did Pat say about the venue?',
    passwordEnvKey: null,
  },
  vikunja: {
    shortName: 'Todo lists',
    // ../assistant docs/todo.md, "Two tokens, enforced by Vikunja" (Vikunja 2.8.0).
    tools: {
      lead: '28 tools on the default and browser profiles to read and change lists, tasks, labels and comments. Unattended runs get the 12 read-only ones.',
      names: ['tasks_list', 'tasks_create', 'tasks_update', 'projects_list', '24 more'],
    },
    setupDetail: 'The database schema, the account and the agents’ two tokens',
    tryAsking: 'Add “renew passport” to my todo list, due Friday.',
    passwordEnvKey: null,
  },
  n8n: {
    shortName: 'n8n',
    // ../assistant addons/n8n/addon.json: exposesToAgent false, and n8n-import generates its credentials.
    tools: null,
    setupDetail: 'The starter workflows and their credentials, on the first start',
    tryAsking: null,
    passwordEnvKey: null,
    doneLine: 'Agents don’t reach n8n. Open it and create the owner account to build workflows.',
  },
  lightrag: {
    shortName: 'LightRAG',
    // ../assistant addons/lightrag/addon.json `mcp.tools`, all read-only.
    tools: {
      lead: '5 read-only tools on the default, browser and API profiles. The tools that change the knowledge graph aren’t registered.',
      names: ['query_document', 'get_documents', 'get_pipeline_status', '2 more'],
    },
    setupDetail: 'The agents’ tools, without restarting the assistant',
    tryAsking: 'What do my documents say about the lease renewal?',
    passwordEnvKey: null,
  },
};

/** What agents may do in a workspace. */
export const ACCESS_LABEL: Record<TwentyAccess, string> = { read: 'Look things up', write: 'Make changes' };

export const OWNER_PASSWORD_COPIED = 'Owner password copied. Boundary clears it from the clipboard in 60 seconds.';

/** Which of a hosted workspace's two keys Boundary holds. */
export function keysText(w: Pick<TwentyWorkspace, 'hasReadKey' | 'hasWriteKey'>): string {
  if (w.hasReadKey && w.hasWriteKey) return 'read-only and read-write keys';
  if (w.hasWriteKey) return 'read-write key only';
  if (w.hasReadKey) return 'read-only key only';
  return 'no keys';
}

/** The pill while an installed add-on's server isn't running. */
const NOT_RUNNING_LABEL = 'Not running';

/** The alert and the detail page's callout for a stopped add-on. */
export function stoppedCopy(name: string): { title: string; body: string } {
  return {
    title: `${name} isn’t running`,
    body: `It’s installed, but its containers aren’t running. Start it to bring its tools back to your agents, or mark it as not installed. Its data stays on this Mac either way.`,
  };
}

/** The detail page's state, and the pill, while the add-on's containers run uninstalled. */
export const LEFTOVER_TITLE = 'Install didn’t finish';

export type PillTone = 'default' | 'brand' | 'ok' | 'warn' | 'destructive' | 'outline';

/** True while an install has started and not finished: running, failed or waiting to restart. */
export const inProgress = (s: AddonInstallSnapshot | null): s is AddonInstallSnapshot =>
  Boolean(s && !s.done);

const restartStep = (s: AddonInstallSnapshot) => s.steps.find((step) => step.id === 'restart');

export const waitingForRestart = (s: AddonInstallSnapshot | null): boolean =>
  Boolean(s && !s.error && restartStep(s)?.status === 'waiting');

/** No engine figures from a running engine. An engine on a host Boundary doesn't control has none to give. */
export const engineDown = (listing: AddonListing): boolean =>
  listing.facts.measured !== false && listing.facts.engineMiB === 0;

/** The card and detail pill: the install's state first, then installed, then the fit. */
export function addonPill(
  listing: AddonListing,
  install: AddonInstallSnapshot | null,
  hostedCount = 0
): { tone: PillTone; label: string; dot?: boolean } {
  if (inProgress(install)) {
    const removal = install.kind === 'remove';
    if (install.error) return { tone: 'destructive', label: removal ? 'Removal failed' : 'Install failed' };
    if (waitingForRestart(install)) return { tone: 'warn', label: 'Restart to finish', dot: true };
    if (install.cancelling) return { tone: 'brand', label: removal ? 'Stopping' : 'Cancelling', dot: true };
    return { tone: 'brand', label: removal ? 'Removing' : 'Installing', dot: true };
  }
  if (listing.installed && listing.stopped) return { tone: 'warn', label: NOT_RUNNING_LABEL };
  if (listing.installed) return { tone: 'ok', label: 'On', dot: true };
  if (listing.leftover) return { tone: 'warn', label: LEFTOVER_TITLE };
  if (hostedCount > 0) return { tone: 'ok', label: 'Connected', dot: true };
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
      return entry.id === 'email' ? 'First pass started' : 'First-time setup';
    case 'connect':
      return 'Connecting the first budget';
    case 'disconnect':
      return entry.id === 'bitwarden' ? 'Disconnecting the accounts' : 'Disconnecting this Mac’s budgets';
    case 'restart':
      return 'Restart the assistant';
    case 'stop':
      return `Stopping ${entry.name}`;
    case 'remove-containers':
      return 'Removing its containers';
    case 'delete-data':
      return 'Deleting its database and files';
    case 'delete-keys':
      return 'Removing the owner sign-in and agent keys';
    case 'delete-images':
      return 'Deleting the downloaded images';
  }
}

export function stepDetail(
  entry: AddonCatalogEntry,
  step: AddonStep,
  kind: AddonInstallSnapshot['kind'] = 'install'
): string {
  if (step.status === 'running' && step.detail) return step.detail;
  switch (step.id) {
    case 'check':
      return entry.port ? `Memory, disk, port ${entry.port.default}` : 'Memory and disk';
    case 'download':
      return entry.services.join(', ');
    case 'start':
      return entry.services.length === 1 ? entry.services[0]! : `${entry.services.length} containers`;
    case 'answer':
      return entry.port ? `localhost:${entry.port.default}` : 'Health check';
    case 'setup':
      return ADDON_FACTS[entry.id].setupDetail;
    case 'connect':
      return 'With Look things up, as budget-<name>-ro';
    case 'disconnect':
      return entry.id === 'bitwarden'
        ? 'Their API keys, master passwords and bw data. Nothing in Bitwarden changes'
        : 'Their entries and stored sign-ins. Budgets on other servers stay';
    case 'restart':
      return kind === 'remove' ? 'So agents drop crm-main' : 'So agents can use the new tools';
    case 'stop':
    case 'remove-containers':
      return entry.services.join(', ');
    case 'delete-data':
      return entry.id === 'actual'
        ? 'This Mac’s server and its budgets'
        : entry.id === 'bitwarden'
          ? 'The add-on’s store and the broker’s data'
          : entry.id === 'email'
            ? 'The index, the drafts queue and the stored passwords'
            : entry.id === 'vikunja'
              ? 'Every list and task, the vikunja database schema and attachments'
              : entry.id === 'n8n'
                ? 'Workflows, credentials, run history and research reports'
                : entry.id === 'lightrag'
                  ? 'The add-on’s settings. The index and graph stay'
                  : 'Postgres data and attachments';
    case 'delete-keys':
      return 'The crm-main workspace file and the owner sign-in';
    case 'delete-images':
      return step.detail ?? '';
  }
}

/** Relative weight of each step in the overall bar, from the prototype. */
const STEP_WEIGHT: Record<AddonStepId, number> = {
  check: 4,
  download: 46,
  start: 12,
  answer: 6,
  setup: 18,
  connect: 10,
  restart: 6,
  disconnect: 10,
  stop: 10,
  'remove-containers': 10,
  'delete-data': 40,
  'delete-keys': 10,
  'delete-images': 20,
};

export function overallPercent(s: AddonInstallSnapshot): number {
  if (s.done && !s.cancelled) return 100;
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

/** The steps of a removal that main hasn't reported yet: what a run from this state would do. */
export function removalSteps(installed: boolean, deleteImages: boolean, id: AddonId = 'twenty'): AddonStepId[] {
  // Actual's removal through addon.sh has no restart: the stack reloads Hermes in place.
  if (id === 'actual') return ['stop', 'delete-data', ...(deleteImages ? (['delete-images'] as const) : [])];
  // Bitwarden's image is built from the stack's tree, so its removal deletes no images.
  if (id === 'bitwarden') return ['disconnect', 'stop', 'delete-data'];
  // Email's removal is `disable`, then `remove email --delete-data`; its image is built locally.
  if (id === 'email') return ['stop', 'delete-data'];
  // Todo lists' removal is the same: `disable`, then `remove vikunja --delete-data`.
  if (id === 'vikunja') return ['stop', 'delete-data'];
  // n8n's and LightRAG's are the same: `disable`, then `remove <id> --delete-data`.
  if (id === 'n8n' || id === 'lightrag') return ['stop', 'delete-data'];
  return [
    'stop',
    'remove-containers',
    'delete-data',
    'delete-keys',
    ...(deleteImages ? (['delete-images'] as const) : []),
    ...(installed ? (['restart'] as const) : []),
  ];
}

/** What a finished removal did, from the run's steps. Catalog sizes are approximate, so they say "about". */
export function freedText(entry: AddonCatalogEntry, s: AddonInstallSnapshot): string {
  const images = s.steps.find((step) => step.id === 'delete-images');
  let disk = '';
  if (images?.status === 'done') {
    const kept = /^Kept (.+): another container uses (?:it|them)\.$/.exec(images.detail ?? '')?.[1];
    // A detail this doesn't recognise means the run didn't delete all of them as planned, so no size.
    disk = kept
      ? ` Deleted its downloaded images except ${kept}, which another container uses.`
      : images.detail
        ? ' Deleted its downloaded images.'
        : ` Deleted its downloaded images (about ${bytesGB(entry.downloadBytes)} GB).`;
  }
  const memory = s.steps.some((step) => step.id === 'restart')
    ? ` Freed about ${memGB(entry.reserveMiB)} GB of engine memory.`
    : '';
  return `Its data is deleted.${disk}${memory}`;
}

/** Add-ons that can run on this Mac or connect to one the person already runs (store decision 14). */
export type TwoWayAddon = 'actual' | 'twenty';

export const isTwoWay = (id: AddonId): id is TwoWayAddon => id === 'actual' || id === 'twenty';

/** What each way does, for the store's choice and the detail page's two cards. */
export const SETUP_WAYS: Record<TwoWayAddon, { here: string; connect: string; connectFacts: string[]; connectLabel: string }> = {
  actual: {
    here: 'Actual runs beside your assistant with a first budget, connected so agents can look things up. You type nothing.',
    connect: 'Agents sign in to an Actual server you already run. Nothing runs on this Mac.',
    connectFacts: ['Nothing to download', 'Needs the server address and password'],
    connectLabel: 'Connect a budget',
  },
  twenty: {
    here: 'Twenty runs in the container engine beside your assistant. Records stay on this Mac. There’s no account to set up: Twenty opens signed in as you.',
    connect:
      'Your agents use a Twenty that runs somewhere else, such as Twenty’s cloud or your company’s server. Nothing runs on this Mac.',
    connectFacts: ['No containers', 'No memory', 'Needs an API key'],
    connectLabel: 'Connect a workspace',
  },
};

/** The figures for running an add-on on this Mac. */
export function hereFacts(entry: AddonCatalogEntry): string[] {
  return [`${memGB(entry.reserveMiB)} GB memory`, `${bytesGB(entry.downloadBytes)} GB download`];
}
