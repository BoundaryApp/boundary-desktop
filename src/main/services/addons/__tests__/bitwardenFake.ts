import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddonScript, AddonScriptLine, AddonScriptOutcome, ScriptJsonOutcome } from '../addonScript';
import type { BrokerNamespaceCheck } from '../bitwardenBrokerNamespace';

// A fake of the stack's Bitwarden commands, built from what was confirmed in the stack's source on
// its main (merge a26f93c, unreleased; scripts/vault.sh, scripts/addon.sh, scripts/lib/addon_cli.py,
// scripts/lib/addon-events.sh, addons/bitwarden/addon.json, broker/server.py):
//
// - addon.sh connect bitwarden --instance S --json: a slug outside the store rule is `bad_input`;
//   a slug in the store is `exists`; then `vault.sh add --json` checks stdin (`bad_input` for
//   scope all, a url with cloud, selfhosted without a url, stored without master_password, an
//   empty client_id or client_secret), an existing account file (`exists`), the broker
//   (`broker_down`), and the sign-in (`login_refused`, `server_unreachable`, `rate_limited` with
//   `retryAfter`, `timeout`, `command_failed`), writing nothing on failure. It restarts the
//   broker, which locks the other unlocked manual accounts; `done` carries `account` and a
//   `message` that names them. The store entry is `instances/S.json` with no secret.
// - addon.sh disconnect bitwarden --instance S --json: `not_found` for a slug not in the store;
//   a missing account file still ends with `done`.
// - addon.sh enable / disable bitwarden --json: BITWARDEN_ENABLED in `.env`, the broker up or
//   stopped; remove --delete-data is `bad_input` while enabled.
// - vault.sh unlock / lock --slug S --json: `bad_slug`, `not_found`, `bad_input` for a stored
//   account or an empty password, `broker_down`, `login_refused` for a wrong password.
// - vault.sh status --json: one object per account file, sorted, `offline`/`broker_down` while
//   the broker is down, exit 0; a refused file has only file, slug, state and error.
//
// From v0.3.14 (tag 4b726a5; scripts/vault.sh cmd_status, broker/accounts.py load_instance and
// read_client_id, scripts/addon.sh cmd_connect): the broker reads each account from the add-on
// store, `instances/<slug>.json` with `secrets/<slug>/client_id`. A refused line's `error` is
// `bad_file`, `bad_slug` (slug null) or `missing_client_id`; the last needs the running broker,
// so with it down that account is `offline`/`broker_down` like the rest. Every account connected
// before v0.3.14 has a store entry and no client_id, and stays `missing_client_id` until
// `addon.sh connect --force` replaces it (`vault.sh add --replace --json`).
// - vault.sh requests --json and sync --json: one object, or exit 1 with nothing on stdout while
//   the broker is down. sync answers `{synced:false, reason:busy}` while busy and the last result
//   with `reason: recent` within 30 s.
// - vault.sh follow-hermes (v0.3.14, cmd_follow_hermes): does nothing while BITWARDEN_ENABLED is
//   off; otherwise `up -d --no-deps bitwarden-broker`, which starts a stopped broker and re-creates
//   one left in a removed hermes's network namespace.
// - A broker left in a removed hermes's namespace keeps running, so status, requests and the other
//   commands read normally (they reach it through `docker compose exec`); status reports
//   broker_down only while the broker container isn't running (vault.sh broker_running,
//   docs/bitwarden.md). doctor.sh finds the stale namespace by comparing the broker's
//   HostConfig.NetworkMode with `container:<running hermes id>`, which `brokerNamespace()` models.

export interface FakeAccount {
  mode: 'cloud' | 'selfhosted' | 'local';
  scope: string;
  unlock: 'manual' | 'stored';
  state: 'unlocked' | 'locked' | 'offline' | 'error';
  error: string | null;
  retryAfter: number | null;
  masterPassword: string;
  /** Connected before v0.3.14: the store entry has no secrets/<slug>/client_id. */
  clientIdMissing?: boolean;
}

export interface BitwardenFakeStack {
  root: string;
  dataRoot: string;
  /** Every call, with its stdin. */
  calls: { script: AddonScript; args: string[]; input?: Record<string, unknown> }[];
  accounts: Map<string, FakeAccount>;
  /** Files the broker refused at start, other than an account with no client_id. */
  refused: { file: string; error: 'bad_file' | 'bad_slug' }[];
  brokerUp: boolean;
  /**
   * The broker runs but sits in the network namespace of a hermes that's gone, as after hermes is
   * recreated. Every `vault.sh` command reads normally; only `brokerNamespace()` reports the
   * mismatch, until `vault.sh follow-hermes` runs.
   */
  brokerStale: boolean;
  /** How many times `brokerNamespace()` was read. */
  namespaceReads: number;
  /** What connect's broker sign-in reports next; null signs in. */
  signIn: { error: string; retryAfter?: number } | null;
  /** The pending requests, and the logins Bitwarden refused to move. */
  pending: { request_id: string; account: string; site: string; reason: string; created: number }[];
  /** Sites the person moved into the folder; the next sync clears their requests. */
  granted: Set<string>;
  syncBusy: boolean;
  /** The next sync is within 30 s of the last. */
  syncRecent: boolean;
  run(script: AddonScript, args: string[], options?: { input?: Record<string, unknown>; onLine?: (line: AddonScriptLine) => void }): Promise<AddonScriptOutcome>;
  runJson(script: AddonScript, args: string[]): Promise<ScriptJsonOutcome>;
  /** doctor.sh's namespace check: no evidence while the broker is stopped, else whether it's in hermes's. */
  brokerNamespace(): Promise<BrokerNamespaceCheck>;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** An account added at the terminal: a file with no store entry. */
  addTerminalAccount(slug: string, account: Partial<FakeAccount>): void;
  /** An account connected before v0.3.14: a store entry, refused with missing_client_id. */
  addPreUpdateAccount(slug: string): void;
  stored(): string[];
  cleanup(): void;
}

const STORE_SLUG = /^[a-z][a-z0-9-]{0,30}$/;
const SLUG = /^[a-z0-9-]+$/;

const done = (fields: Record<string, unknown> = {}, lines: AddonScriptLine[] = []): AddonScriptOutcome => ({
  kind: 'done',
  done: { phase: 'done', ...fields },
  lines,
});
const error = (name: string, message: string, extra: { retryAfter?: number; step?: string } = {}): AddonScriptOutcome => ({
  kind: 'error',
  error: name,
  message,
  step: extra.step ?? null,
  logTail: [],
  lines: [],
  ...(extra.retryAfter ? { retryAfter: extra.retryAfter } : {}),
});
const json = (code: number, objects: Record<string, unknown>[] = [], logTail: string[] = []): ScriptJsonOutcome => ({ code, objects, logTail });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createBitwardenFakeStack(): BitwardenFakeStack {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitwarden-fake-'));
  const dataRoot = path.join(root, 'data');
  const instances = path.join(dataRoot, 'addons', 'bitwarden', 'instances');
  fs.mkdirSync(instances, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_ENABLED=0\n');
  let lastSynced: string[] = [];

  /** The broker container runs; `vault.sh` reaches it through `docker compose exec` whatever its namespace. */
  const answers = () => stack.brokerUp;

  const storeHas = (slug: string) => fs.existsSync(path.join(instances, `${slug}.json`));

  /** The broker restart connect and disconnect run: unlocked manual accounts lock. */
  const restartBroker = (except: string): string[] => {
    const locked: string[] = [];
    for (const [slug, a] of stack.accounts) {
      if (slug !== except && a.unlock === 'manual' && a.state === 'unlocked') {
        a.state = 'locked';
        locked.push(slug);
      }
    }
    return locked;
  };

  const lockedSentence = (locked: string[]) => (locked.length ? ` The broker restart locked ${locked.join(', ')}; unlock them again.` : '');

  function connect(slug: string, input: Record<string, unknown> = {}, force = false): AddonScriptOutcome {
    if (!STORE_SLUG.test(slug)) return error('bad_input', `--instance ${slug} is not a valid name`);
    if (storeHas(slug) && !force) return error('exists', `bitwarden instance ${slug} exists`);
    // --force on a stored slug runs the hook with --replace; on an unknown slug it is a plain connect.
    const replacing = storeHas(slug);
    // vault.sh add --json
    if (slug === 'local') return error('bad_input', 'the slug local belongs to make vault-init', { step: 'check' });
    const mode = str(input.mode);
    const url = str(input.url);
    const region = str(input.region);
    const scope = str(input.scope) || 'folder:Agent';
    const unlock = str(input.unlock) || 'manual';
    if (mode === 'cloud' && (url || !['', 'us', 'eu'].includes(region))) return error('bad_input', 'cloud takes a region, not a url', { step: 'check' });
    if (mode === 'selfhosted' && (region || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[^\s?#]*)?$/.test(url))) {
      return error('bad_input', 'selfhosted needs an https url', { step: 'check' });
    }
    if (mode !== 'cloud' && mode !== 'selfhosted') return error('bad_input', 'mode must be cloud or selfhosted', { step: 'check' });
    if (scope === 'all' || !/^(folder:\S(.*\S)?|collection:[A-Za-z0-9][A-Za-z0-9-]{0,63})$/.test(scope)) {
      return error('bad_input', 'scope must be folder:NAME or collection:ID', { step: 'check' });
    }
    if (unlock !== 'manual' && unlock !== 'stored') return error('bad_input', 'unlock must be stored or manual', { step: 'check' });
    if (stack.accounts.has(slug) && !replacing) return error('exists', `${slug} already has an account file`, { step: 'check' });
    if (!/^\S+$/.test(str(input.client_id)) || !str(input.client_secret)) return error('bad_input', 'client_id and client_secret are required', { step: 'check' });
    if (unlock === 'stored' && !str(input.master_password)) return error('bad_input', 'stored unlock needs master_password', { step: 'check' });
    if (!answers()) return error('broker_down', 'the Bitwarden broker is not running', { step: 'check' });
    const locked = restartBroker(slug);
    // The restart also locks the account being replaced, whether or not the new key signs in.
    const old = replacing ? stack.accounts.get(slug) : undefined;
    if (old?.unlock === 'manual') old.state = 'locked';
    const outcome = stack.signIn;
    stack.signIn = null;
    if (outcome) {
      const kept = replacing ? 'the previous account is back in place' : 'nothing was kept';
      return error(outcome.error, `the broker reports ${slug} as ${outcome.error}; ${kept}`, { step: 'check', retryAfter: outcome.retryAfter });
    }
    stack.accounts.set(slug, {
      mode: mode as FakeAccount['mode'],
      scope,
      unlock: unlock as FakeAccount['unlock'],
      state: unlock === 'stored' ? 'unlocked' : 'locked',
      error: null,
      retryAfter: null,
      masterPassword: str(input.master_password) || 'right-master',
    });
    // `register`: the non-secret settings only.
    fs.writeFileSync(path.join(instances, `${slug}.json`), JSON.stringify({ mode, region, url, scope, unlock }));
    const message = (unlock === 'stored' ? `${slug} is signed in and unlocked.` : `${slug} is signed in and stays locked until you unlock it.`) + lockedSentence(locked);
    return done({ id: 'bitwarden', action: 'connect', restart: [], mcp: [], account: slug, message, ...(replacing ? { replaced: true } : {}) });
  }

  function disconnect(slug: string): AddonScriptOutcome {
    if (!STORE_SLUG.test(slug)) return error('bad_input', `--instance ${slug} is not a valid name`);
    if (!storeHas(slug)) return error('not_found', `no bitwarden instance ${slug}`);
    const had = stack.accounts.delete(slug);
    const locked = stack.brokerUp ? restartBroker(slug) : [];
    fs.rmSync(path.join(instances, `${slug}.json`), { force: true });
    const prefix = had ? '' : `${slug} had no account file. `;
    return done({
      id: 'bitwarden',
      action: 'disconnect',
      restart: [],
      mcp: [],
      message: `${prefix}The API key still exists in Bitwarden; revoke it there (Settings > Security > Keys) if you are done with it.${lockedSentence(locked)}`,
    });
  }

  function manual(slug: string): FakeAccount | AddonScriptOutcome {
    if (!SLUG.test(slug)) return error('bad_slug', `--slug ${slug} is not valid`);
    const account = stack.accounts.get(slug);
    if (!account) return error('not_found', `no account ${slug}`);
    if (account.unlock !== 'manual') return error('bad_input', `${slug} uses stored unlock; the broker unlocks it by itself`);
    return account;
  }

  const stack: BitwardenFakeStack = {
    root,
    dataRoot,
    calls: [],
    accounts: new Map(),
    refused: [],
    brokerUp: false,
    brokerStale: false,
    namespaceReads: 0,
    signIn: null,
    pending: [],
    granted: new Set(),
    syncBusy: false,
    syncRecent: false,

    async run(script, args, options = {}) {
      stack.calls.push({ script, args, ...(options.input ? { input: options.input } : {}) });
      const [command, id] = args;
      const slug = args[args.indexOf(script === 'addon.sh' ? '--instance' : '--slug') + 1] ?? '';
      if (script === 'addon.sh' && id === 'bitwarden') {
        switch (command) {
          case 'enable': {
            const lines: AddonScriptLine[] = [
              { phase: 'setup', step: 'flags', status: 'running' },
              { phase: 'setup', step: 'start', status: 'running' },
              { phase: 'setup', step: 'reload', status: 'running' },
            ];
            lines.forEach((l) => options.onLine?.(l));
            stack.setEnabled(true);
            return done({ id: 'bitwarden', action: 'enable', restart: [], mcp: [] }, lines);
          }
          case 'disable':
            stack.setEnabled(false);
            return done({ id: 'bitwarden', action: 'disable', restart: [], mcp: [] });
          case 'remove':
            if (stack.enabled()) return error('bad_input', 'turn bitwarden off before removing it');
            fs.rmSync(path.join(dataRoot, 'addons', 'bitwarden'), { recursive: true, force: true });
            return done({ id: 'bitwarden', action: 'remove', restart: [], mcp: [] });
          case 'connect':
            return connect(slug, options.input, args.includes('--force'));
          case 'disconnect':
            return disconnect(slug);
        }
      }
      if (script === 'vault.sh' && command === 'follow-hermes') {
        // v0.3.14: starts or re-creates the broker in hermes's current namespace, which locks manual accounts.
        if (!stack.enabled()) return { kind: 'exited', code: 0, logTail: [], lines: [] };
        stack.brokerUp = true;
        stack.brokerStale = false;
        for (const a of stack.accounts.values()) if (a.unlock === 'manual') a.state = 'locked';
        return { kind: 'exited', code: 0, logTail: [], lines: [] };
      }
      if (script === 'vault.sh' && (command === 'unlock' || command === 'lock')) {
        const account = manual(slug);
        if ('kind' in account) return account;
        if (command === 'unlock') {
          const password = str(options.input?.master_password);
          if (!password) return error('bad_input', 'master_password is empty');
          if (!answers()) return error('broker_down', 'the Bitwarden broker is not running');
          if (password !== account.masterPassword) return error('login_refused', 'the master password was refused');
          account.state = 'unlocked';
          return done();
        }
        if (!answers()) return error('broker_down', 'the Bitwarden broker is not running');
        account.state = 'locked';
        return done();
      }
      return { kind: 'exited', code: 1, logTail: [`fake: no ${script} ${args.join(' ')}`], lines: [] };
    },

    async runJson(script, args) {
      stack.calls.push({ script, args });
      const [command] = args;
      const down = () => json(1, [], ['[vault] ERROR: the Bitwarden broker is not running']);
      if (command === 'status') {
        const lines: Record<string, unknown>[] = [...stack.accounts.keys()].sort().map((slug) => {
          const a = stack.accounts.get(slug)!;
          const base = { slug, mode: a.mode, scope: a.scope, unlock: a.unlock };
          if (a.clientIdMissing && answers()) return { file: `${slug}.json`, slug, state: 'refused', error: 'missing_client_id' };
          return answers()
            ? { ...base, state: a.state, error: a.error, retry_after: a.retryAfter }
            : { ...base, state: 'offline', error: 'broker_down', retry_after: null as number | null };
        });
        for (const { file, error } of stack.refused) {
          lines.push({ file, slug: error === 'bad_slug' ? null : file.replace(/\.json$/, ''), state: 'refused', error });
        }
        return json(0, lines);
      }
      if (command === 'requests') {
        if (!answers()) return down();
        return json(0, [{ pending: stack.pending.map((p) => ({ ...p, status: 'pending', done_at: null as number | null })), recent: [] }]);
      }
      if (command === 'sync') {
        if (!answers()) return down();
        if (stack.syncBusy) return json(0, [{ synced: false, reason: 'busy' }]);
        if (stack.syncRecent) return json(0, [{ synced: lastSynced, reason: 'recent' }]);
        lastSynced = [...stack.accounts.entries()].filter(([, a]) => a.state === 'unlocked').map(([slug]) => slug);
        stack.pending = stack.pending.filter((p) => !(stack.granted.has(p.site) && lastSynced.includes(p.account)));
        stack.syncRecent = true;
        return json(0, [{ synced: lastSynced }]);
      }
      return json(1, [], [`fake: no ${script} ${args.join(' ')}`]);
    },

    async brokerNamespace() {
      stack.namespaceReads += 1;
      if (!stack.brokerUp) return { ok: false, reason: 'no_broker' };
      return { ok: true, matches: !stack.brokerStale };
    },

    enabled: () => /BITWARDEN_ENABLED=1/.test(fs.readFileSync(path.join(root, '.env'), 'utf8')),
    setEnabled(on) {
      fs.writeFileSync(path.join(root, '.env'), `BITWARDEN_ENABLED=${on ? 1 : 0}\n`);
      stack.brokerUp = on;
      // A restart locks every manual account.
      if (on) for (const a of stack.accounts.values()) if (a.unlock === 'manual') a.state = 'locked';
    },
    addTerminalAccount(slug, account) {
      stack.accounts.set(slug, {
        mode: 'cloud',
        scope: 'folder:Agent',
        unlock: 'manual',
        state: 'locked',
        error: null,
        retryAfter: null,
        masterPassword: 'right-master',
        ...account,
      });
    },
    addPreUpdateAccount(slug) {
      stack.addTerminalAccount(slug, { clientIdMissing: true });
      fs.writeFileSync(path.join(instances, `${slug}.json`), JSON.stringify({ mode: 'cloud', region: 'us', scope: 'folder:Agent', unlock: 'manual' }));
    },
    stored: () =>
      fs.existsSync(instances)
        ? fs
            .readdirSync(instances)
            .map((n) => n.replace(/\.json$/, ''))
            .sort()
        : [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return stack;
}
