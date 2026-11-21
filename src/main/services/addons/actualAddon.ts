import type {
  ActualAccess,
  ActualBudget,
  ActualBudgetState,
  ActualBudgetsResult,
  ActualConnectInput,
  ActualConnectResult,
  ActualOverview,
  ActualScriptFailure,
  ActualServerBudget,
  ActualServerInput,
} from '../../../shared/types/addons';
import { isActualFailure } from '../../../shared/types/addons';
import { ADDON_SLUG } from '../../../shared/utils/slug';
import { readStackEnv } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';
import { flagOn, outcomeText, readStackFile, scriptFailure, type AddonScript, type AddonScriptLine, type AddonScriptOutcome } from './addonScript';
import { isRecord } from '../../../shared/utils/isRecord';

// Actual Budget's connected budgets (spec decisions 18–25, CR 0026). The stack keeps everything:
// `addon.sh connect actual` stores the session token, `instances/<slug>.json` holds the
// password-free index row, and `budget.sh status` checks each stored sign-in. Boundary keeps
// neither the password nor the token; they pass from the sheet through main to the script's
// stdin and are dropped.

/**
 * The `bind` connect stores for Make changes, the same map `budget.sh access S write` writes:
 * the owner's profile and `browser` get the write server, `api-server` stays read-only (decision
 * 21). Look things up sends no `bind`, which the stack reads as `ro` on every profile.
 */
const WRITE_BIND = { default: 'rw', browser: 'rw', 'api-server': 'ro' } as const;
const ACTUAL_DEFAULT_PORT = 5006;

const STATES: readonly ActualBudgetState[] = [
  'ok',
  'token_expired',
  'no_access',
  'encryption_password',
  'server_unreachable',
  'timeout',
];

/** `budget.sh` runs `actual-admin.mjs` with a 45 s limit per check; connect adds a reload. */
const BUDGETS_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 300_000;
const STATUS_TIMEOUT_MS = 600_000;
/** The first `enable` builds `actual-mcp` from the stack's tree. */
const ENABLE_TIMEOUT_MS = 1_800_000;

/** The stack tree can run Actual as an add-on: `addon.sh`, and a manifest with the init and connect hooks. */
export async function actualAvailable(files: StackFiles): Promise<boolean> {
  if ((await readStackFile(files, 'scripts/addon.sh')) === null) return false;
  const manifest = await readStackFile(files, 'addons/actual/addon.json');
  if (!manifest) return false;
  try {
    const m = JSON.parse(manifest) as { hooks?: { init?: unknown }; instances?: { connect?: unknown } };
    return Boolean(m.hooks?.init && m.instances?.connect);
  } catch {
    return false;
  }
}

export interface ActualFlags {
  enabled: boolean;
  local: boolean;
  port: number;
}

/** Actual's settings in the stack's `.env`, which `addon.sh` writes in both stack modes. */
export async function readActualFlags(files: StackFiles): Promise<ActualFlags> {
  const env = await readStackEnv(files, 'stack', '.env');
  const port = Number(env.ACTUAL_PORT);
  return {
    enabled: flagOn(env.ACTUAL_MCP_ENABLED),
    local: flagOn(env.ACTUAL_LOCAL_ENABLED),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : ACTUAL_DEFAULT_PORT,
  };
}

/** The add-on's store, under the user-content location. */
const ACTUAL_STORE = 'addons/actual';

/**
 * The connected budgets from the index rows. A row carries no secret; an unreadable one is
 * left out. Write access is `bind.default` set to `rw`, as `budget.sh status` derives it; a row
 * with no `bind` is read-only, and an `access` field left from an older stack is ignored.
 */
export async function readActualRows(files: StackFiles): Promise<Omit<ActualBudget, 'state'>[]> {
  let names: string[] | null;
  try {
    names = await files.list('userContent', `${ACTUAL_STORE}/instances`);
  } catch {
    return [];
  }
  const rows: Omit<ActualBudget, 'state'>[] = [];
  for (const name of (names ?? []).filter((n) => n.endsWith('.json')).sort()) {
    const slug = name.slice(0, -'.json'.length);
    if (!ADDON_SLUG.test(slug)) continue;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse((await files.readText('userContent', `${ACTUAL_STORE}/instances/${name}`)) ?? '') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const server = typeof row.server === 'string' ? row.server : '';
    rows.push({
      slug,
      server,
      local: server === 'local',
      syncId: typeof row.sync_id === 'string' ? row.sync_id : '',
      access: bindsWrite(row.bind) ? 'write' : 'read',
    });
  }
  return rows;
}

function bindsWrite(bind: unknown): boolean {
  return isRecord(bind) && bind.default === 'rw';
}

const SERVER_PASSWORD = `${ACTUAL_STORE}/secrets/server_password`;

/** The server password `init --server-only` generated, for Copy password. Null when there is none. */
export async function readLocalServerPassword(files: StackFiles): Promise<string | null> {
  try {
    return ((await files.readText('userContent', SERVER_PASSWORD)) ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** This Mac's server has the password `init --server-only` stored. */
async function localServerSetUp(files: StackFiles): Promise<boolean> {
  try {
    return ((await files.readText('userContent', SERVER_PASSWORD)) ?? '') !== '';
  } catch {
    return false;
  }
}

/* Checks on what the renderer sends, before anything reaches a script. */

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The server and credential from the renderer. `local` needs no credential (the stack uses the
 * password it stored); any other server is an http(s) address with a password or a token.
 */
export function actualServerInput(input: unknown): ActualServerInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const server = typeof i.server === 'string' ? i.server.trim() : '';
  if (server !== 'local' && !/^https?:\/\/\S+$/.test(server)) {
    throw new Error('The server address must start with http:// or https://.');
  }
  const password = optionalText(i.password);
  const sessionToken = optionalText(i.sessionToken);
  if (server !== 'local' && !password && !sessionToken) throw new Error('Enter the server’s password or a session token.');
  return { server, ...(password ? { password } : {}), ...(sessionToken ? { sessionToken } : {}) };
}

/** Checks the connect input field by field; `budget.sh` checks the slug and credential again. */
export function actualConnectInput(input: unknown): ActualConnectInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const server = actualServerInput(input);
  if (typeof i.slug !== 'string' || !ADDON_SLUG.test(i.slug)) throw new Error('Use lowercase letters, numbers and dashes for the name.');
  const slug = i.slug;
  if (typeof i.syncId !== 'string' || !i.syncId.trim()) throw new Error('Pick a budget to connect.');
  if (i.access !== 'read' && i.access !== 'write') throw new Error('Access must be read or write.');
  const access: ActualAccess = i.access;
  if (typeof i.replace !== 'boolean') throw new Error('Say whether to replace an existing budget.');
  const encryptionPassword = optionalText(i.encryptionPassword);
  return {
    ...server,
    slug,
    syncId: i.syncId.trim(),
    access,
    replace: i.replace,
    ...(encryptionPassword ? { encryptionPassword } : {}),
  };
}

const failure = scriptFailure;

/** The stdin object `budgets` and `connect` take. Credentials only; empty ones are left out. */
function serverInput(input: ActualServerInput): Record<string, unknown> {
  const out: Record<string, unknown> = { server: input.server };
  if (input.sessionToken) out.session_token = input.sessionToken;
  else if (input.password) out.password = input.password;
  return out;
}

export interface ActualServiceDeps {
  paths(): { root: string; dataRoot: string };
  /** The stack's files: the add-on's store and its server password. */
  files: StackFiles;
  /** Runs a stack script with the stack's script environment, in the stack root. */
  run(
    script: AddonScript,
    args: string[],
    options?: { input?: Record<string, unknown>; timeoutMs?: number; onLine?: (line: AddonScriptLine) => void }
  ): Promise<AddonScriptOutcome>;
  /** The add-on lock every install, removal and connect shares. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Metadata only: never a credential, a budget name or a sync id. */
  log(message: string, data: Record<string, unknown>): void;
}

export interface ActualService {
  overview(): Promise<ActualOverview>;
  /** Runs `budget.sh status --json` and keeps each row's state. Resolves with the new overview. */
  refreshStatus(): Promise<ActualOverview>;
  /** The budgets the credential can open, from `budget.sh budgets --json`. Writes nothing. */
  serverBudgets(input: ActualServerInput): Promise<ActualBudgetsResult>;
  /** Turns the add-on on when it's off, then `addon.sh connect actual`, under the add-on lock. */
  connect(input: ActualConnectInput): Promise<ActualConnectResult>;
  /** `connect` for a caller that already holds the lock (the install's first budget). */
  connectUnlocked(input: ActualConnectInput): Promise<ActualConnectResult>;
  disconnect(slug: string): Promise<{ ok: true } | ActualScriptFailure>;
  /** `disconnect` for a caller that already holds the lock (removal). */
  disconnectUnlocked(slug: string): Promise<{ ok: true } | ActualScriptFailure>;
  setAccess(slug: string, access: ActualAccess): Promise<{ ok: true; mcp: string[] } | ActualScriptFailure>;
  /** `addon.sh enable actual --json`, under the caller's lock. */
  enable(options?: { reinit?: boolean; onLine?: (line: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
}

export function createActualService(deps: ActualServiceDeps): ActualService {
  const states = new Map<string, ActualBudgetState>();
  let statusError: string | null = null;

  const overview = async (): Promise<ActualOverview> => {
    const flags = await readActualFlags(deps.files);
    const budgets = (await readActualRows(deps.files)).map((row): ActualBudget => {
      // A row on this Mac's server while it's off can't sign in, whatever status said last.
      const state = row.local && !flags.local ? 'server_off' : (states.get(row.slug) ?? null);
      return { ...row, state };
    });
    return {
      enabled: flags.enabled,
      local: flags.local,
      localSetUp: await localServerSetUp(deps.files),
      budgets,
      statusError,
    };
  };

  const enable: ActualService['enable'] = async (options = {}) => {
    const outcome = await deps.run('addon.sh', ['enable', 'actual', ...(options.reinit ? ['--reinit'] : []), '--json'], {
      timeoutMs: ENABLE_TIMEOUT_MS,
      onLine: options.onLine,
    });
    deps.log('enable', { reinit: Boolean(options.reinit), outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
    return outcome;
  };

  const disconnectUnlocked = async (slug: string): Promise<{ ok: true } | ActualScriptFailure> => {
    const outcome = await deps.run('addon.sh', ['disconnect', 'actual', '--instance', slug, '--json'], {
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    deps.log('disconnect', { outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
    if (outcome.kind !== 'done') return failure(outcome);
    states.delete(slug);
    return { ok: true };
  };

  const connectUnlocked = async (input: ActualConnectInput): Promise<ActualConnectResult> => {
    if (!(await readActualFlags(deps.files)).enabled) {
      // A budget connected while the add-on is off is stored, but Hermes registers none.
      const enabled = await enable();
      if (enabled.kind !== 'done') return failure(enabled);
    }
    if (input.replace) {
      // The stack's connect has no --force (gap 1): remove the old one first.
      const removed = await disconnectUnlocked(input.slug);
      if (isActualFailure(removed) && removed.error !== 'not_found') return removed;
    }
    const stdin: Record<string, unknown> = {
      ...serverInput(input),
      sync_id: input.syncId,
    };
    if (input.access === 'write') stdin.bind = WRITE_BIND;
    if (input.encryptionPassword) stdin.encryption_password = input.encryptionPassword;
    const outcome = await deps.run('addon.sh', ['connect', 'actual', '--instance', input.slug, '--json'], {
      input: stdin,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    deps.log('connect', {
      local: input.server === 'local',
      access: input.access,
      replace: input.replace,
      token: Boolean(input.sessionToken),
      outcome: outcome.kind,
      error: outcome.kind === 'error' ? outcome.error : null,
    });
    if (outcome.kind !== 'done') return failure(outcome);
    states.set(input.slug, 'ok');
    const mcp = Array.isArray(outcome.done.mcp) ? outcome.done.mcp.filter((n): n is string => typeof n === 'string') : [];
    return { ok: true, mcp };
  };

  return {
    overview,

    async refreshStatus() {
      const outcome = await deps.run('budget.sh', ['status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS });
      if (outcome.kind === 'done') {
        states.clear();
        for (const line of outcome.lines) {
          if (line.phase !== 'budget' || typeof line.slug !== 'string') continue;
          const state = STATES.includes(line.state as ActualBudgetState) ? (line.state as ActualBudgetState) : 'unknown';
          states.set(line.slug, state);
        }
        statusError = null;
      } else {
        statusError = outcomeText(outcome);
      }
      deps.log('status', {
        outcome: outcome.kind,
        rows: states.size,
        notOk: [...states.values()].filter((s) => s !== 'ok').length,
      });
      return overview();
    },

    async serverBudgets(input) {
      const outcome = await deps.run('budget.sh', ['budgets', '--json'], {
        input: serverInput(input),
        timeoutMs: BUDGETS_TIMEOUT_MS,
      });
      deps.log('budgets', { local: input.server === 'local', outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
      if (outcome.kind !== 'done') return failure(outcome);
      const budgets: ActualServerBudget[] = [];
      for (const line of outcome.lines) {
        if (line.phase !== 'budget' || typeof line.sync_id !== 'string' || !line.sync_id) continue;
        budgets.push({
          syncId: line.sync_id,
          name: typeof line.name === 'string' ? line.name : line.sync_id,
          encrypted: line.encrypted === true,
        });
      }
      return { ok: true, budgets };
    },

    connect: (input) => deps.exclusive(() => connectUnlocked(input)),
    connectUnlocked: (input) => connectUnlocked(input),
    disconnectUnlocked,

    disconnect: (slug) => deps.exclusive(() => disconnectUnlocked(slug)),

    setAccess: (slug, access) =>
      deps.exclusive(async () => {
        const outcome = await deps.run('budget.sh', ['access', slug, access, '--json'], { timeoutMs: CONNECT_TIMEOUT_MS });
        deps.log('access', { access, outcome: outcome.kind, error: outcome.kind === 'error' ? outcome.error : null });
        if (outcome.kind !== 'done') return failure(outcome);
        const mcp = Array.isArray(outcome.done.mcp) ? outcome.done.mcp.filter((n): n is string => typeof n === 'string') : [];
        return { ok: true as const, mcp };
      }),

    enable,
  };
}

/**
 * Where Open Actual goes for a row: `localUrl` (this Mac's server), or the row's own server. Null
 * for anything not http(s).
 */
export function actualOpenUrl(budget: Pick<ActualBudget, 'local' | 'server'> | null, localUrl: string): string | null {
  if (!budget || budget.local) return localUrl;
  try {
    const url = new URL(budget.server);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
