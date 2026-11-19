import path from 'node:path';
import type {
  ActualScriptFailure,
  EmailAccount,
  EmailAccountInput,
  EmailMailbox,
  EmailMailboxesResult,
  EmailOverview,
  EmailSecurity,
  EmailSettingsInput,
} from '../../../shared/types/addons';
import { isEmailSlug, plainAllowed } from '../../../shared/emailAccount';
import { readEnvFile } from '../assistant/stackEnv';
import { accountState, parseIndexerLog, type AccountChange, type IndexerLog } from './emailIndexLog';
import {
  enableAddon,
  findListEntry,
  readStackFile,
  scriptFailure,
  type AddonScriptLine,
  type AddonScriptOutcome,
  type PlainOutcome,
} from './addonScript';

// The IMAP email add-on (stack v0.3.13). The stack keeps everything: `addon.sh configure email`
// stores settings and accounts, `addon.sh run email mailboxes` lists a mailbox, and the
// `email-indexer` container indexes. Boundary keeps no password: it goes from the sheet through
// main to the stdin of `configure` and is dropped. Nothing here logs an address, host, user,
// slug or mailbox name.

/** `run email mailboxes` builds the image on its first run. */
const MAILBOXES_TIMEOUT_MS = 900_000;
const CONFIGURE_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 60_000;
const ENABLE_TIMEOUT_MS = 1_800_000;

const BUSY_MESSAGE = 'Another add-on change is running. Try again in a moment.';

/** The stack tree offers email: `addon.sh`, and a manifest with accounts as instances and a mailboxes command. */
export function emailAvailable(
  root: string,
  read: (p: string) => string | null = readStackFile
): boolean {
  const manifest = read(path.join(root, 'addons', 'email', 'addon.json'));
  if (manifest === null || read(path.join(root, 'scripts', 'addon.sh')) === null) return false;
  let m: { instances?: { name?: unknown }; commands?: { mailboxes?: unknown } };
  try {
    m = JSON.parse(manifest);
  } catch {
    return false;
  }
  return m.instances?.name === 'accounts' && Boolean(m.commands?.mailboxes);
}

const on = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test((value ?? '').trim());

/** Email's flags in the stack's `.env`, which `addon.sh` writes. */
export function readEmailFlags(root: string): { enabled: boolean; drafts: boolean } {
  const env = readEnvFile(path.join(root, '.env'));
  return { enabled: on(env.EMAIL_ENABLED), drafts: on(env.EMAIL_DRAFTS_ENABLED) };
}

/* Checks on what the renderer sends, before anything reaches a script. */

const SECURITIES: readonly EmailSecurity[] = ['tls', 'starttls', 'plain'];

export function emailAccountInput(input: unknown): EmailAccountInput {
  const i = (input ?? {}) as Record<string, unknown>;
  if (!isEmailSlug(i.slug)) throw new Error('Use lowercase letters, numbers and dashes for the name.');
  const host = typeof i.host === 'string' ? i.host.trim() : '';
  if (!host) throw new Error('Enter the mail server’s address.');
  if (typeof i.port !== 'number' || !Number.isInteger(i.port) || i.port < 1 || i.port > 65535) {
    throw new Error('The port must be a number from 1 to 65535.');
  }
  if (typeof i.security !== 'string' || !SECURITIES.includes(i.security as EmailSecurity)) {
    throw new Error('Security must be tls, starttls or plain.');
  }
  const security = i.security as EmailSecurity;
  if (security === 'plain' && !plainAllowed(host)) {
    throw new Error('An unencrypted connection is allowed only to localhost, 127.0.0.1 or host.docker.internal.');
  }
  const user = typeof i.user === 'string' ? i.user.trim() : '';
  if (!user) throw new Error('Enter the user name.');
  const address = typeof i.address === 'string' ? i.address.trim() : '';
  if (!address) throw new Error('Enter the email address.');
  let password: string | null;
  if (i.password === null) password = null;
  else if (typeof i.password === 'string') {
    if (i.password === '') throw new Error('Enter the password.');
    if (/[\r\n]/.test(i.password)) throw new Error('The password can’t contain a line break.');
    password = i.password;
  } else {
    throw new Error('The password must be text, or null to keep the stored one.');
  }
  return { slug: i.slug, host, port: i.port, security, user, address, password };
}

export function emailSettingsInput(input: unknown): EmailSettingsInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const since = typeof i.since === 'string' ? i.since : '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(since) ? new Date(`${since}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== since) {
    throw new Error('Enter the start date as YYYY-MM-DD.');
  }
  if (typeof i.attachments !== 'boolean') throw new Error('Say whether to include attachment text.');
  if (typeof i.drafts !== 'boolean') throw new Error('Say whether drafts are on.');
  return { since, attachments: i.attachments, drafts: i.drafts };
}

export interface EmailServiceDeps {
  paths(): { root: string; dataRoot: string };
  /** `addon.sh <args>` with stdin JSON; no phase lines expected (`configure`, `run`, `list --json`). */
  plain(args: string[], options?: { input?: Record<string, unknown>; timeoutMs?: number }): Promise<PlainOutcome>;
  run(
    script: 'addon.sh',
    args: string[],
    options?: { onLine?: (l: AddonScriptLine) => void; timeoutMs?: number }
  ): Promise<AddonScriptOutcome>;
  /** The `email-indexer` compose log with timestamps, or null when it can't be read. */
  indexerLog(): Promise<string | null>;
  restartIndexer(): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  now(): Date;
  /** Counts, codes and outcomes only. */
  log(message: string, data: Record<string, unknown>): void;
}

type Ok = { ok: true } | ActualScriptFailure;

export interface EmailService {
  overview(): EmailOverview;
  refresh(): Promise<EmailOverview>;
  saveAccount(input: EmailAccountInput): Promise<Ok>;
  listMailboxes(slug: string): Promise<EmailMailboxesResult>;
  setMailboxes(slug: string, mailboxes: string[]): Promise<Ok>;
  /** Cancel after a refused login: removes the account only if no mailboxes were ever saved. */
  removeNewAccount(slug: string): Promise<void>;
  removeAccount(slug: string): Promise<Ok>;
  setSettings(input: EmailSettingsInput): Promise<Ok>;
  /** `addon.sh enable email --json`, under the caller's lock. */
  enable(options?: { onLine?: (l: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
  onChange(cb: (o: EmailOverview) => void): () => void;
}

interface StoredAccount {
  slug: string;
  host: string;
  port: number;
  security: EmailSecurity;
  user: string;
  address: string;
  mailboxes: string[];
  passwordSet: boolean;
}

interface StoredEmail {
  since: string | null;
  attachments: boolean;
  accounts: StoredAccount[];
}

const EMPTY_LOG: IndexerLog = { lastPass: null, skipped: {}, passEnds: [], latestAt: null };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function mailboxNames(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((n): n is string => typeof n === 'string' && n !== '');
  if (typeof v === 'string') return v.split(',').map((n) => n.trim()).filter(Boolean);
  return [];
}

/** The `email` entry of `addon.sh list --json`; null when it isn't there or doesn't parse. */
function parseList(stdout: string): StoredEmail | null {
  const entry = findListEntry(stdout, 'email');
  if (!entry) return null;
  const settings = isRecord(entry.settings) ? entry.settings : {};
  const instances = isRecord(entry.instances) ? entry.instances : {};
  const accounts: StoredAccount[] = [];
  for (const [slug, raw] of Object.entries(instances)) {
    if (!isRecord(raw) || !isEmailSlug(slug)) continue;
    const security = SECURITIES.includes(raw.security as EmailSecurity) ? (raw.security as EmailSecurity) : 'tls';
    const port = Number(raw.port);
    accounts.push({
      slug,
      host: str(raw.host),
      port: Number.isInteger(port) ? port : 993,
      security,
      user: str(raw.user),
      address: str(raw.address),
      mailboxes: mailboxNames(raw.mailboxes),
      passwordSet: isRecord(raw.password) && raw.password.set === true,
    });
  }
  const since = typeof settings.since === 'string' && settings.since ? settings.since : null;
  return { since, attachments: settings.attachments === true, accounts };
}

/** The last stderr line that starts `error: `, prefix removed; the stack prints a synopsis after some. */
const errorLine = (outcome: PlainOutcome): string | null => {
  const line = outcome.stderrTail.map((l) => l.trim()).filter((l) => l.startsWith('error: ')).at(-1);
  return line === undefined ? null : line.slice('error: '.length);
};

export function createEmailService(deps: EmailServiceDeps): EmailService {
  let stored: StoredEmail = { since: null, attachments: false, accounts: [] };
  let indexer: IndexerLog = EMPTY_LOG;
  let readError: string | null = null;
  /** Boundary's last change to each account, by slug. Memory only: a restart of Boundary forgets it. */
  const changes = new Map<string, AccountChange>();
  const listeners = new Set<(o: EmailOverview) => void>();

  const overview = (): EmailOverview => {
    const { root } = deps.paths();
    const flags = readEmailFlags(root);
    const accounts = stored.accounts.map((a): EmailAccount => {
      const health = accountState(a.slug, a.host, changes.get(a.slug) ?? null, indexer);
      return { ...a, ...health };
    });
    const pass = indexer.lastPass;
    // Owed: an account Boundary changed is still waiting for a pass that started after the change.
    const passOwed = flags.enabled && accounts.some((a) => changes.has(a.slug) && a.state === 'waiting');
    return {
      available: emailAvailable(root),
      enabled: flags.enabled,
      drafts: flags.drafts,
      since: stored.since,
      attachments: stored.attachments,
      accounts,
      lastPass: pass ? { at: pass.at, inScope: pass.inScope } : null,
      passOwed,
      readError,
    };
  };

  function emit(): void {
    const o = overview();
    for (const cb of listeners) cb(o);
  }

  const readStored = async (): Promise<StoredEmail | null> => {
    const outcome = await deps.plain(['list', '--json'], { timeoutMs: LIST_TIMEOUT_MS });
    if (outcome.code !== 0) {
      readError = `addon.sh list exited with code ${outcome.code}`;
      return null;
    }
    const parsed = parseList(outcome.stdout);
    if (!parsed) {
      readError = 'addon.sh list printed no email entry';
      return null;
    }
    readError = null;
    return parsed;
  };

  const refresh = async (): Promise<EmailOverview> => {
    const parsed = await readStored();
    if (parsed) stored = parsed;
    const { root } = deps.paths();
    // A failed read keeps what was known; only a successful one replaces it.
    if (parsed) {
      if (readEmailFlags(root).enabled) {
        const text = await deps.indexerLog().catch((): null => null);
        if (text !== null) indexer = parseIndexerLog(text);
      } else {
        indexer = EMPTY_LOG;
      }
    }
    const o = overview();
    deps.log('refresh', {
      read: parsed !== null,
      accounts: o.accounts.length,
      enabled: o.enabled,
      passOwed: o.passOwed,
      indexed: o.accounts.filter((a) => a.state === 'indexed').length,
    });
    emit();
    return o;
  };

  /** Writes through `configure` and maps its exit codes to named failures. */
  const configure = async (
    what: string,
    args: string[],
    input?: Record<string, unknown>
  ): Promise<Ok> => {
    const outcome = await deps.plain(['configure', 'email', ...args], { input, timeoutMs: CONFIGURE_TIMEOUT_MS });
    deps.log(what, { code: outcome.code });
    if (outcome.code === 0) return { ok: true };
    const line = errorLine(outcome);
    // The lock conflict prints only to stderr (addon.sh lines 323 and 330 at v0.3.13): a running change, or a stale lock file.
    if (outcome.code === 1 && line !== null && /another add-on change is running|is not a lock symlink/.test(line)) {
      return { ok: false, error: 'busy', message: BUSY_MESSAGE };
    }
    if (outcome.code === 2) return { ok: false, error: 'bad_input', message: line ?? 'The stack refused the input.' };
    return { ok: false, error: 'command_failed', message: line ?? `addon.sh configure exited with code ${outcome.code}` };
  };

  const enabledNow = (): boolean => readEmailFlags(deps.paths().root).enabled;

  const touch = (slugs: string[]): void => {
    const at = deps.now().toISOString();
    // While Email is off, email-indexer is stopped, so the next pass starts after this change.
    const startedAfter = enabledNow() ? null : '';
    for (const s of slugs) changes.set(s, { at, startedAfter });
    emit();
  };

  /** Drops an account Boundary removed, so the overview it emits no longer lists it. */
  const forget = (slug: string): void => {
    changes.delete(slug);
    stored = { ...stored, accounts: stored.accounts.filter((a) => a.slug !== slug) };
    emit();
  };

  /**
   * Restarts email-indexer after a stored change. A failure is logged and swallowed: the change
   * is stored, and the indexer applies it on its next pass. Once the restart is done, the old
   * process has finished its pass and exited, so every pass line after the log's latest line
   * comes from a pass that started after the changes made so far.
   */
  const restartIndexer = async (): Promise<void> => {
    try {
      await deps.restartIndexer();
    } catch {
      deps.log('restart-indexer', { ok: false });
      return;
    }
    const text = await deps.indexerLog().catch((): null => null);
    if (text === null) return;
    const mark = parseIndexerLog(text).latestAt ?? '';
    for (const change of changes.values()) {
      if (change.startedAfter === null) change.startedAfter = mark;
    }
  };

  const enableUnlocked = async (options: { onLine?: (l: AddonScriptLine) => void } = {}): Promise<AddonScriptOutcome> => {
    return enableAddon(deps, 'email', { timeoutMs: ENABLE_TIMEOUT_MS, onLine: options.onLine });
  };

  return {
    overview,
    refresh,

    saveAccount: (input) =>
      deps.exclusive(async () => {
        const stdin: Record<string, unknown> = {
          host: input.host,
          port: input.port,
          security: input.security,
          user: input.user,
          address: input.address,
        };
        if (input.password !== null) stdin.password = input.password;
        const result = await configure('save-account', ['--instance', input.slug], stdin);
        if (!result.ok) return result;
        touch([input.slug]);
        // A new password applies from the indexer's next pass; restart so that pass starts now.
        if (input.password !== null && enabledNow()) {
          const current = await readStored();
          if (current?.accounts.some((a) => a.slug === input.slug && a.mailboxes.length > 0)) await restartIndexer();
        }
        return result;
      }),

    async listMailboxes(slug) {
      const outcome = await deps.plain(['run', 'email', 'mailboxes', '--instance', slug], { timeoutMs: MAILBOXES_TIMEOUT_MS });
      if (outcome.code === 0) {
        let rows: unknown;
        try {
          rows = JSON.parse(outcome.stdout);
        } catch {
          rows = null;
        }
        if (!Array.isArray(rows)) {
          deps.log('mailboxes', { code: 0, count: 0, parsed: false });
          return { ok: false, error: 'listing_failed', message: 'addon.sh run printed no mailbox list' };
        }
        const mailboxes: EmailMailbox[] = [];
        for (const r of rows) {
          if (!isRecord(r) || typeof r.mailbox !== 'string' || !r.mailbox) continue;
          const use = Array.isArray(r.special_use)
            ? r.special_use.filter((u): u is string => typeof u === 'string')
            : typeof r.special_use === 'string' && r.special_use
              ? [r.special_use]
              : [];
          mailboxes.push({
            name: r.mailbox,
            messages: typeof r.messages === 'number' ? r.messages : null,
            specialUse: use,
          });
        }
        deps.log('mailboxes', { code: 0, count: mailboxes.length, parsed: true });
        return { ok: true, mailboxes };
      }
      const line = outcome.stderrTail.filter((l) => /^(mail-index|email-addon):/.test(l.trim())).at(-1);
      const message =
        (line ? line.trim().replace(/^(mail-index|email-addon):\s*/, '') : '') ||
        (outcome.code === 2 ? (errorLine(outcome) ?? '') : '');
      let error = 'listing_failed';
      if (message.includes('the server rejected the user name or password')) error = 'login_refused';
      else if (message.includes("can't connect to")) error = 'server_unreachable';
      deps.log('mailboxes', { code: outcome.code, error });
      return { ok: false, error, message: message || `addon.sh run exited with code ${outcome.code}` };
    },

    setMailboxes: (slug, mailboxes) =>
      deps.exclusive(async () => {
        const result = await configure('set-mailboxes', ['--instance', slug], { mailboxes });
        if (!result.ok) return result;
        touch([slug]);
        if (enabledNow()) await restartIndexer();
        return result;
      }),

    removeNewAccount: (slug) =>
      deps.exclusive(async () => {
        const current = await readStored();
        const account = current?.accounts.find((a) => a.slug === slug);
        if (!account || account.mailboxes.length > 0) {
          deps.log('remove-new', { removed: false });
          return;
        }
        const result = await configure('remove-new', ['--instance', slug, '--remove']);
        if (result.ok) forget(slug);
      }),

    removeAccount: (slug) =>
      deps.exclusive(async () => {
        const result = await configure('remove-account', ['--instance', slug, '--remove']);
        if (!result.ok) return result;
        forget(slug);
        if (enabledNow()) await restartIndexer();
        return result;
      }),

    setSettings: (input) =>
      deps.exclusive(async () => {
        const before = await readStored();
        const wasDrafts = readEmailFlags(deps.paths().root).drafts;
        const result = await configure('settings', [], {
          since: input.since,
          bodies: true,
          attachments: input.attachments,
          drafts: input.drafts,
        });
        if (!result.ok) return result;
        // Drafts don't change what the indexer reads, so only the window and attachments mark the accounts.
        const indexChanged = !before || before.since !== input.since || before.attachments !== input.attachments;
        if (indexChanged) touch((before?.accounts ?? stored.accounts).map((a) => a.slug));
        if (enabledNow()) {
          if (wasDrafts !== input.drafts) {
            const enabled = await enableUnlocked();
            if (enabled.kind !== 'done') return scriptFailure(enabled);
          }
          // `enable` doesn't recreate email-indexer for a settings.env change.
          if (indexChanged) await restartIndexer();
        }
        return result;
      }),

    enable: (options) => enableUnlocked(options),

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
