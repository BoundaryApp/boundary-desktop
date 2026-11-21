import type {
  ActualScriptFailure,
  BitwardenAccount,
  BitwardenAccountState,
  BitwardenConnectInput,
  BitwardenConnectResult,
  BitwardenOverview,
  BitwardenRequest,
  BitwardenServer,
  BitwardenSyncResult,
} from '../../../shared/types/addons';
import { bitwardenServerUrl, isBitwardenScope, isBitwardenSlug } from '../../../shared/bitwardenSlug';
import { readStackEnv } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';
import { enableAddon, flagOn, readStackFile, scriptFailure, type AddonScript, type AddonScriptLine, type AddonScriptOutcome, type ScriptJsonOutcome } from './addonScript';
import { isRecord } from '../../../shared/utils/isRecord';

// Bitwarden's connected accounts and the agent's access requests (spec decisions 26–32, CR 0028).
// The stack keeps everything: `addon.sh connect bitwarden` writes the account file and its
// secrets, `vault.sh status --json` reports each account's state, and `vault.sh requests --json`
// the pending requests. The API key and master passwords pass from the sheet through main to the
// script's stdin and are dropped; argv carries only the account's name.

const STATES: readonly BitwardenAccountState[] = ['unlocked', 'locked', 'offline', 'error', 'refused'];

/** Connect writes the files, restarts the broker and waits for its sign-in. */
const CONNECT_TIMEOUT_MS = 300_000;
const UNLOCK_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 120_000;
/** The least time between two broker repairs, so a broker that stays down isn't restarted on every refresh. */
const BROKER_REPAIR_INTERVAL_MS = 60_000;
/** The first `enable` pulls the broker's image. */
const ENABLE_TIMEOUT_MS = 1_800_000;

/** Whether the add-on's manifest runs `bitwarden-signin` (stack v0.3.16's `services.signin`). */
export async function stackHasSignInBrowser(files: StackFiles): Promise<boolean> {
  const manifest = await readStackFile(files, 'addons/bitwarden/addon.json');
  if (!manifest) return false;
  try {
    const services = (JSON.parse(manifest) as { services?: Record<string, { compose?: unknown }> }).services ?? {};
    return Object.values(services).some((service) => service?.compose === 'bitwarden-signin');
  } catch {
    return false;
  }
}

/**
 * Boundary lists Bitwarden in the add-on store, and gives compose the `bitwarden` profile while
 * `BITWARDEN_ENABLED=1`, when the stack tree can run it: `addon.sh`, `vault.sh`, and a manifest
 * with accounts as instances. From stack v0.3.16 the broker has its own network namespace, so a
 * restart or recreate of `hermes` leaves it running.
 */
export async function bitwardenOffered(files: StackFiles): Promise<boolean> {
  if ((await readStackFile(files, 'scripts/addon.sh')) === null) return false;
  if ((await readStackFile(files, 'scripts/vault.sh')) === null) return false;
  const manifest = await readStackFile(files, 'addons/bitwarden/addon.json');
  if (!manifest) return false;
  try {
    const m = JSON.parse(manifest) as { instances?: { connect?: unknown; disconnect?: unknown } };
    return Boolean(m.instances?.connect && m.instances?.disconnect);
  } catch {
    return false;
  }
}

/** `BITWARDEN_ENABLED` in the stack's `.env`, which `addon.sh enable` and `disable` write. */
export async function readBitwardenEnabled(files: StackFiles): Promise<boolean> {
  return flagOn((await readStackEnv(files, 'stack', '.env')).BITWARDEN_ENABLED);
}

/** Accounts the add-on store (`addons/bitwarden` under the user-content location) has an entry for, which `addon.sh disconnect` can remove. */
async function readStoredAccounts(files: StackFiles): Promise<Set<string>> {
  try {
    const names = (await files.list('userContent', 'addons/bitwarden/instances')) ?? [];
    return new Set(names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)));
  } catch {
    return new Set();
  }
}

/* Checks on what the renderer sends, before anything reaches a script. */

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function serverInput(value: unknown): BitwardenServer {
  const v = (value ?? {}) as Record<string, unknown>;
  if (v.kind === 'us' || v.kind === 'eu') return { kind: v.kind };
  if (v.kind === 'selfhosted') {
    const url = bitwardenServerUrl(text(v.url));
    if (!url) throw new Error('A self-hosted server’s address must start with https:// and name a host.');
    return { kind: 'selfhosted', url };
  }
  throw new Error('Choose bitwarden.com (US), bitwarden.com (EU) or your own server.');
}

/**
 * Checks the connect input field by field, so the sheet never sends what the stack rejects as
 * `bad_input` (spec, phase 8): `scope: all`, a URL with bitwarden.com, a self-hosted server
 * without one, Keep me unlocked without a master password, or the name `local`.
 */
export function bitwardenConnectInput(input: unknown): BitwardenConnectInput {
  const i = (input ?? {}) as Record<string, unknown>;
  if (!isBitwardenSlug(i.slug)) {
    throw new Error('Start the name with a letter, and use up to 31 lowercase letters, numbers and dashes. It can’t be local.');
  }
  const server = serverInput(i.server);
  const scope = text(i.scope).trim();
  if (!isBitwardenScope(scope)) throw new Error('Name a folder, or an organization collection ID.');
  if (i.unlock !== 'manual' && i.unlock !== 'stored') throw new Error('Choose how the account unlocks.');
  const clientId = text(i.clientId).trim();
  const clientSecret = text(i.clientSecret).trim();
  if (!clientId || !clientSecret) throw new Error('Enter the API key’s client_id and client_secret.');
  const masterPassword = text(i.masterPassword);
  if (i.unlock === 'stored' && !masterPassword) throw new Error('Keep me unlocked needs the master password.');
  if (/[\r\n]/.test(clientId + clientSecret + masterPassword)) throw new Error('A key or password can’t contain a line break.');
  if (typeof i.replace !== 'boolean') throw new Error('Say whether to replace an existing account.');
  return {
    replace: i.replace,
    slug: i.slug,
    server,
    scope,
    unlock: i.unlock,
    clientId,
    clientSecret,
    ...(i.unlock === 'stored' ? { masterPassword } : {}),
  };
}

/** The stdin object `vault.sh add --json` reads through `addon.sh connect` (CR 0028 R1). */
export function connectStdin(input: BitwardenConnectInput): Record<string, unknown> {
  const out: Record<string, unknown> =
    input.server.kind === 'selfhosted'
      ? { mode: 'selfhosted', url: input.server.url }
      : { mode: 'cloud', region: input.server.kind };
  out.scope = input.scope;
  out.unlock = input.unlock;
  out.client_id = input.clientId;
  out.client_secret = input.clientSecret;
  if (input.unlock === 'stored' && input.masterPassword) out.master_password = input.masterPassword;
  return out;
}

const failure = scriptFailure;

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Stack 0.3.16's last `status --json` line, `{"signer":"<state>"}`, which describes the sign-in
 * signer rather than an account. Account lines, refused ones included, always carry `state`.
 */
function isSignerLine(line: Record<string, unknown>): boolean {
  return 'signer' in line && !('state' in line);
}

/** One `status --json` line as an account row. */
export function accountFromStatus(line: Record<string, unknown>, stored: Set<string>): BitwardenAccount {
  const slug = str(line.slug);
  const state = STATES.includes(line.state as BitwardenAccountState) ? (line.state as BitwardenAccountState) : 'unknown';
  const retry = line.retry_after;
  return {
    slug,
    mode: str(line.mode),
    scope: str(line.scope),
    unlock: line.unlock === 'manual' || line.unlock === 'stored' ? line.unlock : null,
    state,
    error: str(line.error),
    retryAfter: typeof retry === 'number' && Number.isFinite(retry) ? Math.max(0, Math.round(retry)) : null,
    file: str(line.file),
    canDisconnect: slug !== null && stored.has(slug),
  };
}

/** `requests --json`'s `pending` list; entries without an id or account are left out. */
export function parseRequests(reply: Record<string, unknown>): BitwardenRequest[] {
  const list = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value) ? value.filter(isRecord) : [];
  const requests: BitwardenRequest[] = [];
  for (const p of list(reply.pending)) {
    const requestId = str(p.request_id);
    const account = str(p.account);
    if (!requestId || !account) continue;
    requests.push({
      requestId,
      account,
      site: text(p.site),
      reason: text(p.reason),
      created: typeof p.created === 'number' ? p.created : 0,
    });
  }
  return requests;
}

/** A `vault.sh` read that exited with no reply: its last stderr line, or the exit code. */
const readError = (outcome: ScriptJsonOutcome): string =>
  outcome.logTail.at(-1) ?? `vault.sh exited with code ${outcome.code}`;

/**
 * `sync` and `requests` exit 1 when the broker isn't running or doesn't answer, and 2 when it
 * answers with an error (vault.sh, `broker.cli`).
 */
const readFailureName = (code: number): string => (code === 1 ? 'broker_down' : 'command_failed');

type RunOptions = { input?: Record<string, unknown>; timeoutMs?: number; onLine?: (line: AddonScriptLine) => void };

export interface BitwardenServiceDeps {
  /** The stack's files: its `.env` and the add-on's store. */
  files: StackFiles;
  /** Runs a stack script that prints `phase` lines, with the stack's script environment. */
  run(script: AddonScript, args: string[], options?: RunOptions): Promise<AddonScriptOutcome>;
  /** Runs a `vault.sh` command that prints plain JSON objects. */
  runJson(script: AddonScript, args: string[], options?: { timeoutMs?: number }): Promise<ScriptJsonOutcome>;
  /** The add-on lock every install, removal and connect shares. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Starts a stopped broker (`docker compose up -d --no-deps bitwarden-broker`); `refresh()` calls
   * it when the status reads `broker_down`, then reads the status again. Without it, `refresh()`
   * never repairs.
   */
  startBroker?: () => Promise<void>;
  /** Creates the folders the broker mounts; `enable` runs it first because `addon.sh enable` doesn't. */
  ensureFolders: () => Promise<void>;
  /** Milliseconds, for the repair's throttle. Defaults to `Date.now`. */
  now?: () => number;
  /** Metadata only: never a secret, an account name, a site or the agent's reason. */
  log(message: string, data: Record<string, unknown>): void;
}

export interface BitwardenService {
  overview(): Promise<BitwardenOverview>;
  /**
   * Runs `status --json` and `requests --json`, then answers with the new overview. When the
   * broker reads `broker_down`, it first runs `startBroker` and reads the status again, at most
   * once a minute. `repair: false` skips that.
   */
  refresh(options?: { repair?: boolean }): Promise<BitwardenOverview>;
  /** Runs `requests --json` only, after a chat turn that asked for a login. */
  refreshRequests(): Promise<BitwardenOverview>;
  /** Turns the add-on on when it's off, then `addon.sh connect bitwarden`, under the add-on lock. */
  connect(input: BitwardenConnectInput): Promise<BitwardenConnectResult>;
  disconnect(slug: string): Promise<{ ok: true; message: string } | ActualScriptFailure>;
  /** `disconnect` for a caller that already holds the lock. */
  disconnectUnlocked(slug: string): Promise<{ ok: true; message: string } | ActualScriptFailure>;
  unlock(slug: string, masterPassword: string): Promise<{ ok: true } | ActualScriptFailure>;
  lock(slug: string): Promise<{ ok: true } | ActualScriptFailure>;
  /** `vault.sh sync --json`, then `requests --json` so a granted request clears. */
  sync(): Promise<BitwardenSyncResult>;
  /** `addon.sh enable bitwarden --json`, under the caller's lock. */
  enable(options?: { onLine?: (line: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
  /** Each new overview, for the renderer. */
  onChange(cb: (overview: BitwardenOverview) => void): () => void;
}

export function createBitwardenService(deps: BitwardenServiceDeps): BitwardenService {
  let accounts: BitwardenAccount[] = [];
  let requests: BitwardenRequest[] = [];
  let statusError: string | null = null;
  /** The signer state from stack 0.3.16's status line, for the log; null on older stacks. */
  let signer: string | null = null;
  /** The last status read exited 1, which is how the stack reports a broker that doesn't answer. */
  let statusFailedExit1 = false;
  let requestsError: string | null = null;
  const listeners = new Set<(o: BitwardenOverview) => void>();

  const overview = async (): Promise<BitwardenOverview> => ({
    enabled: await readBitwardenEnabled(deps.files),
    accounts,
    requests,
    statusError,
    requestsError,
    signInBrowser: await stackHasSignInBrowser(deps.files),
  });

  const changed = async (): Promise<BitwardenOverview> => {
    const next = await overview();
    for (const cb of listeners) cb(next);
    return next;
  };

  const readStatus = async (): Promise<void> => {
    const outcome = await deps.runJson('vault.sh', ['status', '--json'], { timeoutMs: READ_TIMEOUT_MS });
    if (outcome.code === 0) {
      const stored = await readStoredAccounts(deps.files);
      accounts = outcome.objects.filter((line) => !isSignerLine(line)).map((line) => accountFromStatus(line, stored));
      signer = str(outcome.objects.find(isSignerLine)?.signer);
      statusError = null;
      statusFailedExit1 = false;
    } else {
      statusError = readError(outcome);
      statusFailedExit1 = outcome.code === 1;
    }
    deps.log('status', {
      code: outcome.code,
      accounts: accounts.length,
      states: accounts.map((a) => (a.error ? `${a.state}/${a.error}` : a.state)),
      ...(signer ? { signer } : {}),
    });
  };

  const now = deps.now ?? (() => Date.now());
  let lastRepair: number | null = null;

  /** Bitwarden is on and the status read says the broker doesn't answer: the read failed with broker_down, or every account reads broker_down. */
  const brokerDown = (): boolean => {
    if (statusError !== null) return statusFailedExit1;
    // A refused file (bad_file, bad_slug) shows whether or not the broker answers, so it says nothing about the broker.
    const read = accounts.filter((a) => a.state !== 'refused');
    return read.length > 0 && read.every((a) => a.error === 'broker_down');
  };

  const repairAllowed = async (at: number): Promise<boolean> =>
    !!deps.startBroker && (lastRepair === null || at - lastRepair >= BROKER_REPAIR_INTERVAL_MS) && (await readBitwardenEnabled(deps.files));

  const repairBroker = async (): Promise<void> => {
    const started = now();
    if (!deps.startBroker || !brokerDown() || !(await repairAllowed(started))) return;
    lastRepair = started;
    await deps.startBroker();
    deps.log('repair', { reason: 'broker_down', ms: now() - started });
    await readStatus();
  };

  const readRequests = async (): Promise<void> => {
    if (!(await readBitwardenEnabled(deps.files))) {
      requests = [];
      requestsError = null;
      return;
    }
    const outcome = await deps.runJson('vault.sh', ['requests', '--json'], { timeoutMs: READ_TIMEOUT_MS });
    const reply = outcome.code === 0 ? outcome.objects.at(-1) : undefined;
    if (reply) {
      requests = parseRequests(reply);
      requestsError = null;
    } else {
      // The requests live in the broker, so none can be shown while it doesn't answer.
      requests = [];
      requestsError = readFailureName(outcome.code);
    }
    deps.log('requests', { code: outcome.code, pending: requests.length });
  };

  const enable: BitwardenService['enable'] = async (options = {}) => {
    try {
      await deps.ensureFolders();
    } catch (error) {
      deps.log('enable folders failed', { error: error instanceof Error ? error.name : typeof error });
      return {
        kind: 'error',
        error: 'command_failed',
        message: error instanceof Error ? error.message : 'Bitwarden’s folders couldn’t be created.',
        step: 'folders',
        logTail: [],
        lines: [],
      };
    }
    return enableAddon(deps, 'bitwarden', { timeoutMs: ENABLE_TIMEOUT_MS, onLine: options.onLine });
  };

  const disconnectUnlocked = async (slug: string): Promise<{ ok: true; message: string } | ActualScriptFailure> => {
    const outcome = await deps.run('addon.sh', ['disconnect', 'bitwarden', '--instance', slug, '--json'], {
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    deps.log('disconnect', { outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
    await readStatus();
    await changed();
    if (outcome.kind !== 'done') return failure(outcome);
    return { ok: true, message: text(outcome.done.message) };
  };

  /** `vault.sh unlock` or `lock` for one account, then the states again (decision 27). */
  const accountCommand = async (
    command: 'unlock' | 'lock',
    slug: string,
    input?: Record<string, unknown>
  ): Promise<{ ok: true } | ActualScriptFailure> => {
    const outcome = await deps.run('vault.sh', [command, '--slug', slug, '--json'], { input, timeoutMs: UNLOCK_TIMEOUT_MS });
    deps.log(command, { outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
    await readStatus();
    await changed();
    return outcome.kind === 'done' ? { ok: true } : failure(outcome);
  };

  return {
    overview,

    async refresh(options = {}) {
      await readStatus();
      if (options.repair !== false) await repairBroker();
      await readRequests();
      return changed();
    },

    async refreshRequests() {
      await readRequests();
      return changed();
    },

    connect: (input) =>
      deps.exclusive(async (): Promise<BitwardenConnectResult> => {
        // With the broker down connect writes nothing and fails with broker_down, so turn it on first.
        const enabled = (await readBitwardenEnabled(deps.files)) ? null : await enable();
        if (enabled && enabled.kind !== 'done') return failure(enabled);
        // --force replaces an account already connected under this name; the stack keeps
        // the old one until the new key signs in, and puts it back if it doesn't.
        const args = ['connect', 'bitwarden', '--instance', input.slug, '--json'];
        if (input.replace) args.push('--force');
        const outcome = await deps.run('addon.sh', args, {
          input: connectStdin(input),
          timeoutMs: CONNECT_TIMEOUT_MS,
        });
        deps.log('connect', {
          server: input.server.kind,
          scope: input.scope.startsWith('collection:') ? 'collection' : 'folder',
          unlock: input.unlock,
          replace: input.replace,
          outcome: outcome.kind,
          error: outcome.kind === 'error' ? outcome.error : null,
        });
        // The broker restarted: other manual accounts are locked now (decision 29).
        await readStatus();
        await changed();
        if (outcome.kind === 'done') return { ok: true, message: text(outcome.done.message) };
        const failed = failure(outcome);
        return outcome.kind === 'error' && outcome.retryAfter !== undefined ? { ...failed, retryAfter: outcome.retryAfter } : failed;
      }),

    disconnect: (slug) => deps.exclusive(() => disconnectUnlocked(slug)),
    disconnectUnlocked,

    unlock: (slug, masterPassword) => accountCommand('unlock', slug, { master_password: masterPassword }),

    lock: (slug) => accountCommand('lock', slug),

    async sync() {
      const outcome = await deps.runJson('vault.sh', ['sync', '--json'], { timeoutMs: READ_TIMEOUT_MS });
      const reply = outcome.code === 0 ? outcome.objects.at(-1) : undefined;
      let result: BitwardenSyncResult;
      if (!reply) {
        result = { ok: false, error: readFailureName(outcome.code), message: readError(outcome) };
      } else if (reply.synced === false) {
        result = { ok: false, error: reply.reason === 'busy' ? 'busy' : 'command_failed', message: '' };
      } else {
        // A `busy` list names accounts the sync loop held; they sync on its next pass.
        const synced = Array.isArray(reply.synced) ? reply.synced.filter((s): s is string => typeof s === 'string') : [];
        result = { ok: true, synced, recent: reply.reason === 'recent' };
      }
      deps.log('sync', { code: outcome.code, ok: result.ok, recent: result.ok ? result.recent : null, error: 'error' in result ? result.error : null });
      if (result.ok) await readRequests();
      await changed();
      return result;
    },

    enable,

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
