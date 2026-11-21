import type { AddonFit, AddonHostFacts } from '../addonFit';

/** Add-ons this build knows. A store or IPC call can carry an id from another build. */
export const ADDON_IDS = ['twenty', 'actual', 'bitwarden', 'email', 'vikunja', 'n8n', 'lightrag'] as const;

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
  /**
   * The profile and services that run only while the add-on is installed on this Mac, when
   * that isn't all of `services`: Actual's MCP containers also serve budgets on other servers,
   * so only `actual-server` says whether it's installed, stopped or left over.
   */
  ownServices?: { profile: string; services: string[] };
  reserveMiB: number;
  limitMiB: number;
  downloadBytes: number;
  port: { envKey: string; default: number } | null;
  restartsHermes: boolean;
  account: { username: string } | null;
}

export type AddonStepId =
  | 'check'
  | 'download'
  | 'start'
  | 'answer'
  | 'setup'
  | 'connect'
  | 'restart'
  | 'disconnect'
  | 'stop'
  | 'remove-containers'
  | 'delete-data'
  | 'delete-keys'
  | 'delete-images';

export interface AddonStep {
  id: AddonStepId;
  /** `cancelled`: the step that was running when the user cancelled the run. */
  status: 'pending' | 'running' | 'done' | 'error' | 'waiting' | 'cancelled';
  detail?: string;
  bytes?: { done: number; total: number };
}

/** An install or a removal, which share the installer's snapshot and its progress events. */
export interface AddonInstallSnapshot {
  id: AddonId;
  kind: 'install' | 'remove';
  steps: AddonStep[];
  error?: { step: AddonStepId; message: string; logTail: string[] };
  /** The user asked to cancel and the run is stopping. */
  cancelling?: boolean;
  /**
   * The run ended because the user cancelled it, with `done` true. An install has removed what
   * it started; a removal stopped before it deleted anything.
   */
  cancelled?: boolean;
  done: boolean;
}

const DELETE_STEPS: readonly AddonStepId[] = ['delete-data', 'delete-keys', 'delete-images'];

/**
 * Whether the run can still be cancelled: an install until its restart step, a removal until a
 * delete step starts.
 */
export function canCancelAddonRun(s: AddonInstallSnapshot | null): boolean {
  if (!s || s.done || s.error || s.cancelling) return false;
  const later: readonly AddonStepId[] = s.kind === 'install' ? ['restart'] : DELETE_STEPS;
  return s.steps.every((step) => !later.includes(step.id) || step.status === 'pending');
}

/** A cancelled run's last snapshot: the running step shows as cancelled, the run as done. */
export function cancelledSnapshot(s: AddonInstallSnapshot): AddonInstallSnapshot {
  return {
    ...s,
    steps: s.steps.map((step) => (step.status === 'running' ? { ...step, status: 'cancelled', detail: undefined } : step)),
    cancelling: false,
    cancelled: true,
    done: true,
  };
}

/** Why Remove and delete data is unavailable when Boundary runs the developer's own stack checkout. */
export const ADDON_LOCAL_REMOVE_MESSAGE =
  "Remove the add-on's data from the stack checkout instead; Boundary doesn't delete files in a local stack.";

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
  /**
   * Recorded as installed, but its server isn't running while the agent stack is ready: a
   * local stack started by its own `make up` without the add-on, or a server that exited.
   * The app offers to start it, or to record it as not installed.
   */
  stopped: boolean;
  /**
   * Todo lists: its files folder from an earlier install is still on this Mac, so its lists are
   * too. n8n: it's off and its `n8n_storage` volume is still there. Remove deletes them.
   */
  dataLeft?: boolean;
  fit: AddonFit;
  facts: AddonHostFacts;
}

/** What the agent may do in a Twenty workspace: look things up (`read`) or make changes (`write`). */
export type TwentyAccess = 'read' | 'write';

/** What `crm.sh add` gets to connect a hosted workspace. The keys go in its environment. */
export interface TwentyConnectInput {
  slug: string;
  url: string;
  keyRw: string;
  keyRo: string;
  access: TwentyAccess;
  replace: boolean;
}

export type TwentyConnectResult =
  | { ok: true; checks: string[] }
  | {
      ok: false;
      reason: 'no-answer' | 'rejected' | 'exists' | 'no-catalog' | 'invalid' | 'failed';
      key?: 'RW' | 'RO';
      status?: number;
      message: string;
      checks: string[];
    };

/** One Twenty workspace file, without its API keys. */
export interface TwentyWorkspace {
  /** The file name without `.env`; the agent sees it as `crm-<slug>`. */
  slug: string;
  /** Twenty runs in this stack's own `twenty-server` container. */
  local: boolean;
  url: string;
  workspaceUrl: string;
  access: TwentyAccess;
  /** Why the stack's bootstrap skips this file (an unknown `TWENTY_ACCESS`), or null. */
  skippedReason: string | null;
  hasReadKey: boolean;
  hasWriteKey: boolean;
}

/** What the agent may do with an Actual budget: look things up (`read`) or make changes (`write`). */
export type ActualAccess = 'read' | 'write';

/**
 * A connected budget's sign-in, from `budget.sh status --json`. `server_off` is Boundary's own:
 * the row is on this Mac's server while that server is turned off. `unknown` is a state this
 * build doesn't know.
 */
export type ActualBudgetState =
  | 'ok'
  | 'token_expired'
  | 'no_access'
  | 'encryption_password'
  | 'server_unreachable'
  | 'timeout'
  | 'server_off'
  | 'unknown';

/** One connected budget, from the stack's index row. Never carries a password or token. */
export interface ActualBudget {
  /** Agents see `budget-<slug>`, with write tools when `access` is `write`. */
  slug: string;
  /** `local` for this Mac's server, else the server's address. */
  server: string;
  local: boolean;
  /** The budget's Sync ID on its server; not a secret. */
  syncId: string;
  /** `write` when the row's `bind` gives the owner's profile (`default`) `rw`. */
  access: ActualAccess;
  /** Null until `status` has checked it. */
  state: ActualBudgetState | null;
}

export interface ActualOverview {
  /** `ACTUAL_MCP_ENABLED`: Hermes registers the connected budgets. */
  enabled: boolean;
  /** `ACTUAL_LOCAL_ENABLED`: this Mac's server runs. */
  local: boolean;
  /** This Mac's server has a stored password (`init --server-only` ran). */
  localSetUp: boolean;
  budgets: ActualBudget[];
  /** Why the last `status` run failed, or null. */
  statusError: string | null;
}

/** A server and the credential that signs in to it. Credentials go only to the script's stdin. */
export interface ActualServerInput {
  /** `local`, or an `http(s)://` address. */
  server: string;
  password?: string;
  sessionToken?: string;
}

export interface ActualServerBudget {
  syncId: string;
  name: string;
  encrypted: boolean;
}

/** A named error from `budget.sh` or `addon.sh`, keyed on the name, never the exit code. */
export interface ActualScriptFailure {
  ok: false;
  error: string;
  message: string;
}

/** True for a failed script result. */
export function isActualFailure(result: { ok: boolean }): result is ActualScriptFailure {
  return result.ok === false;
}

export type ActualBudgetsResult = { ok: true; budgets: ActualServerBudget[] } | ActualScriptFailure;

export interface ActualConnectInput extends ActualServerInput {
  slug: string;
  syncId: string;
  encryptionPassword?: string;
  access: ActualAccess;
  /**
   * Replace a budget already connected under `slug` (Sign in again, or replacing an `exists`
   * name). The stack's connect has no `--force`, so main disconnects it first.
   */
  replace: boolean;
}

export type ActualConnectResult = { ok: true; mcp: string[] } | ActualScriptFailure;

/**
 * A Bitwarden account's state, from `vault.sh status --json` (CR 0028 R2). `refused` is an
 * account file the stack can't read. `unknown` is a state this build doesn't know.
 */
export type BitwardenAccountState = 'unlocked' | 'locked' | 'offline' | 'error' | 'refused' | 'unknown';

/** How an account unlocks: `manual` (Ask me each time) or `stored` (Keep me unlocked). */
export type BitwardenUnlock = 'manual' | 'stored';

/** One account, from a `status --json` line. Never carries the API key or a master password. */
export interface BitwardenAccount {
  /** The account's name; null only for a refused file the stack couldn't name. */
  slug: string | null;
  /** `cloud`, `selfhosted`, or `local` for the stack's own Vaultwarden account. */
  mode: string | null;
  /** `folder:<name>`, `collection:<id>`, or `all` for a terminal-added account. */
  scope: string | null;
  unlock: BitwardenUnlock | null;
  state: BitwardenAccountState;
  /**
   * `login_refused`, `server_unreachable`, `rate_limited`, `unknown`, `bad_file`, `not_loaded`,
   * `broker_down`, or null.
   */
  error: string | null;
  /** Seconds to wait while rate limited, or null when unknown. */
  retryAfter: number | null;
  /** The refused file's name (`refused` only). */
  file: string | null;
  /** The add-on store has an entry for it, so `addon.sh disconnect` can remove it. */
  canDisconnect: boolean;
}

/** A login the agent asked for and can't reach (`requests --json`, `pending[]`). */
export interface BitwardenRequest {
  requestId: string;
  account: string;
  site: string;
  /** The agent's words. */
  reason: string;
  /** Unix seconds. */
  created: number;
}

export interface BitwardenOverview {
  /** `BITWARDEN_ENABLED` in the stack's `.env`. */
  enabled: boolean;
  accounts: BitwardenAccount[];
  requests: BitwardenRequest[];
  /** Why the last `status` run failed, or null. */
  statusError: string | null;
  /** `broker_down` or `command_failed` when the last `requests` run had no reply, else null. */
  requestsError: string | null;
  /**
   * The stack signs the agent in through `bitwarden-signin` (stack v0.3.16): a login is filled into
   * the agent's own page only when its item has the `agent-in-page-fill` custom field.
   */
  signInBrowser: boolean;
}

/** Where the account lives (decision 28). */
export type BitwardenServer = { kind: 'us' } | { kind: 'eu' } | { kind: 'selfhosted'; url: string };

/** What the connect sheet sends. Main writes the secrets to `addon.sh`'s stdin and keeps none. */
export interface BitwardenConnectInput {
  slug: string;
  server: BitwardenServer;
  /** `folder:<name>` or `collection:<id>`. */
  scope: string;
  unlock: BitwardenUnlock;
  clientId: string;
  clientSecret: string;
  /** With `stored` only. */
  masterPassword?: string;
  /**
   * Replace an account already connected under `slug` (`addon.sh connect --force`). The stack
   * keeps the old account until the new key signs in, and puts it back if it doesn't.
   */
  replace: boolean;
}

/** `connect`'s `done` message names the manual accounts its broker restart locked. */
export type BitwardenConnectResult = { ok: true; message: string } | (ActualScriptFailure & { retryAfter?: number | null });

/**
 * `vault.sh sync --json` (CR 0028 R4). `recent`: the reply is the last sync's, from within 30
 * seconds. Another sync running is the failure `busy`; the broker down is `broker_down`.
 */
export type BitwardenSyncResult = { ok: true; synced: string[]; recent: boolean } | ActualScriptFailure;

export type EmailSecurity = 'tls' | 'starttls' | 'plain';

export type EmailProviderId = 'icloud' | 'gmail' | 'fastmail' | 'yahoo' | 'other';

/** One account as the connect sheet sends it. A null `password` keeps the stored one. */
export interface EmailAccountInput {
  slug: string;
  host: string;
  port: number;
  security: EmailSecurity;
  user: string;
  address: string;
  password: string | null;
}

/** A mailbox the server lists. `messages` is null when the server did not say. */
export interface EmailMailbox {
  name: string;
  messages: number | null;
  specialUse: string[];
}

export type EmailMailboxesResult = { ok: true; mailboxes: EmailMailbox[] } | ActualScriptFailure;

export interface EmailSettingsInput {
  /** `YYYY-MM-DD`; `1970-01-01` is everything. */
  since: string;
  attachments: boolean;
  drafts: boolean;
}

export type EmailAccountState = 'waiting' | 'indexed' | 'login_refused' | 'unreachable' | 'left_out';

export interface EmailAccount {
  slug: string;
  host: string;
  port: number;
  security: EmailSecurity;
  user: string;
  address: string;
  mailboxes: string[];
  passwordSet: boolean;
  state: EmailAccountState;
  detail: string | null;
  indexedAt: string | null;
}

export interface EmailOverview {
  available: boolean;
  enabled: boolean;
  drafts: boolean;
  since: string | null;
  attachments: boolean;
  accounts: EmailAccount[];
  lastPass: { at: string; inScope: number } | null;
  passOwed: boolean;
  readError: string | null;
}

/**
 * Options for an add-on install. `access` is the first connection's access. `remote` is Actual
 * only: the add-on is off, so the install turns it on without this Mac's server and connects
 * that budget, with the progress view showing the steps. `email.account` is the slug the first
 * install connects.
 */
export interface AddonInstallOptions {
  access?: TwentyAccess;
  remote?: ActualConnectInput;
  email?: { account: string };
  /**
   * When the add-on needs more memory than the engine has and the engine can grow, restart the
   * engine at a size that fits before installing (ADR 0055 §3).
   */
  makeRoom?: boolean;
}
