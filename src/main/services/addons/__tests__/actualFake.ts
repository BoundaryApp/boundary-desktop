import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddonScript, AddonScriptLine, AddonScriptOutcome } from '../addonScript';

// A fake of the stack's Actual scripts, built from what was confirmed in the stack's source
// (main, merge 7b44898, per-instance binding):
//
// - addon.sh connect actual --instance S --json, stdin {server, sync_id, bind?, password |
//   session_token, encryption_password}: `bad_input` for a setting the manifest doesn't list
//   (`profile` and `access` among them) or a `bind` that `addon_manifest.bind_problem` refuses,
//   `exists` for a slug already in instances/, then the hook's checks in budget.sh's order (sync
//   id, sign-in, open), then the index row with `bind` beside the settings and `done` with
//   `account` and `mcp` (`budget-S`).
// - addon.sh disconnect actual --instance S --json: `not_found` for an unknown slug.
// - addon.sh enable actual [--reinit] --json: ACTUAL_MCP_ENABLED=1 (and ACTUAL_LOCAL_ENABLED
//   from the stored `local` setting), `pull` and `setup` lines, `done`.
// - addon.sh disable actual --json: both flags 0. configure actual: no JSON, exit 0.
// - addon.sh remove actual --delete-data --json: `bad_input` while enabled, else deletes the store.
// - budget.sh budgets --json: `budget` lines with sync_id, name, encrypted, then `done`.
// - budget.sh status --json: one `budget` line per index row with `access` (write when
//   `bind.default` is rw) and its state, then `done`.
// - budget.sh access S read|write --json: stores the bind (`ro` everywhere, or default and
//   browser `rw`), `done` with `mcp` (`budget-S`).

export interface FakeServer {
  password: string;
  budgets: { syncId: string; name: string; encrypted?: string }[];
}

export interface ActualFakeStack {
  root: string;
  dataRoot: string;
  /** Every call, with its stdin. */
  calls: { script: AddonScript; args: string[]; input?: Record<string, unknown> }[];
  servers: Record<string, FakeServer>;
  /** `status` states by slug; `ok` when absent. */
  states: Record<string, string>;
  /** The next call that matches answers with this outcome instead. */
  override: ((script: AddonScript, args: string[]) => AddonScriptOutcome | null) | null;
  run(
    script: AddonScript,
    args: string[],
    options?: { input?: Record<string, unknown>; onLine?: (line: AddonScriptLine) => void }
  ): Promise<AddonScriptOutcome>;
  env(): Record<string, string>;
  setEnv(values: Record<string, string>): void;
  addRow(slug: string, row: Record<string, unknown>): void;
  rows(): string[];
  cleanup(): void;
}

const done = (fields: Record<string, unknown> = {}, lines: AddonScriptLine[] = []): AddonScriptOutcome => ({
  kind: 'done',
  done: { phase: 'done', ...fields },
  lines,
});
const error = (name: string, message: string, step: string | null = null): AddonScriptOutcome => ({
  kind: 'error',
  error: name,
  message,
  step,
  logTail: [],
  lines: [],
});

/** `instances.settings` in Actual's manifest, plus the stack's own `bind`. */
const CONNECT_KEYS = new Set(['server', 'sync_id', 'session_token', 'password', 'encryption_password', 'bind']);
/** Actual's `mcp.profiles`. */
const BIND_PROFILES = new Set(['default', 'browser', 'api-server']);

/** `addon_manifest.bind_problem` for Actual, which reads no personal-data class. */
function bindProblem(bind: unknown): string | null {
  if (!bind || typeof bind !== 'object' || Array.isArray(bind)) return 'must map profiles to ro or rw';
  for (const [profile, level] of Object.entries(bind)) {
    if (!BIND_PROFILES.has(profile)) return `names '${profile}', which is not in the manifest's mcp.profiles`;
    if (level !== 'ro' && level !== 'rw') return `${profile} must be ro or rw`;
    if (profile === 'api-server' && level === 'rw') return 'api-server may only be ro';
  }
  return null;
}

export function createActualFakeStack(): ActualFakeStack {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-fake-'));
  const dataRoot = path.join(root, 'data');
  const store = path.join(dataRoot, 'addons', 'actual');
  fs.mkdirSync(path.join(store, 'instances'), { recursive: true });
  fs.mkdirSync(path.join(store, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'ACTUAL_PORT=5006\n');
  let storedLocal = false;

  const stack: ActualFakeStack = {
    root,
    dataRoot,
    calls: [],
    servers: {
      local: { password: '', budgets: [{ syncId: 'local-1', name: 'Budget' }] },
      'https://budget.example.com': {
        password: 'right-password',
        budgets: [
          { syncId: 'home-1', name: 'Home' },
          { syncId: 'vault-1', name: 'Vault', encrypted: 'enc-pass' },
        ],
      },
    },
    states: {},
    override: null,
    env() {
      const out: Record<string, string> = {};
      for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line);
        if (m) out[m[1]!] = m[2]!;
      }
      return out;
    },
    setEnv(values) {
      const merged = { ...stack.env(), ...values };
      fs.writeFileSync(path.join(root, '.env'), Object.entries(merged).map(([k, v]) => `${k}=${v}\n`).join(''));
    },
    addRow(slug, row) {
      fs.writeFileSync(path.join(store, 'instances', `${slug}.json`), JSON.stringify(row));
    },
    rows() {
      return fs.readdirSync(path.join(store, 'instances')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
    async run(script, args, options = {}) {
      const input = options.input;
      stack.calls.push({ script, args, ...(input ? { input } : {}) });
      const forced = stack.override?.(script, args) ?? null;
      if (forced) return forced;
      const [cmd] = args;
      const signIn = (server: string): FakeServer | AddonScriptOutcome => {
        const known = stack.servers[server];
        if (!known) return error('server_unreachable', `no answer from ${server}`);
        if (server === 'local') return known;
        if (typeof input?.session_token === 'string') {
          return input.session_token === 'good-token' ? known : error('token_expired', 'the session token has expired');
        }
        if (input?.password !== known.password) return error('login_refused', 'the server refused the password');
        return known;
      };
      if (script === 'budget.sh' && cmd === 'budgets') {
        if (!input) return error('not_found', 'stdin is not a JSON object');
        const server = signIn(String(input.server));
        if ('kind' in server) return server;
        const lines = server.budgets.map(
          (b): AddonScriptLine => ({ phase: 'budget', sync_id: b.syncId, name: b.name, encrypted: Boolean(b.encrypted) })
        );
        for (const line of lines) options.onLine?.(line);
        return done({}, lines);
      }
      if (script === 'budget.sh' && cmd === 'status') {
        const lines = stack.rows().map((slug): AddonScriptLine => {
          const row = JSON.parse(fs.readFileSync(path.join(store, 'instances', `${slug}.json`), 'utf8')) as Record<string, unknown>;
          const bind = row.bind as Record<string, unknown> | undefined;
          return { phase: 'budget', slug, access: bind?.default === 'rw' ? 'write' : 'read', state: stack.states[slug] ?? 'ok' };
        });
        return done({}, lines);
      }
      if (script === 'budget.sh' && cmd === 'access') {
        const [, slug, access] = args;
        if (access !== 'read' && access !== 'write') return error('bad_access', 'access must be read or write');
        if (!stack.rows().includes(slug!)) return error('not_found', `no budget connected as ${slug}`);
        const rw = access === 'write' ? 'rw' : 'ro';
        const row = JSON.parse(fs.readFileSync(path.join(store, 'instances', `${slug}.json`), 'utf8')) as Record<string, unknown>;
        stack.addRow(slug!, { ...row, bind: { default: rw, browser: rw, 'api-server': 'ro' } });
        return done({ mcp: [`budget-${slug}`] });
      }
      if (script === 'addon.sh' && cmd === 'configure') {
        if (typeof input?.local === 'boolean') storedLocal = input.local;
        return { kind: 'exited', code: 0, logTail: [], lines: [] };
      }
      if (script === 'addon.sh' && cmd === 'enable') {
        stack.setEnv({ ACTUAL_MCP_ENABLED: '1', ACTUAL_LOCAL_ENABLED: storedLocal ? '1' : '0' });
        const lines: AddonScriptLine[] = [
          { phase: 'pull', service: 'actual-server', current: 50, total: 100 },
          { phase: 'pull', service: 'actual-server', current: 100, total: 100 },
          { phase: 'setup', step: 'flags', status: 'running' },
          { phase: 'setup', step: 'flags', status: 'done' },
          { phase: 'setup', step: 'start', status: 'running' },
          { phase: 'setup', step: 'start', status: 'done' },
          { phase: 'setup', step: 'init', status: 'running' },
          { phase: 'setup', step: 'init', status: 'done' },
          { phase: 'setup', step: 'reload', status: 'running' },
          { phase: 'setup', step: 'reload', status: 'done' },
        ];
        if (storedLocal) fs.writeFileSync(path.join(store, 'secrets', 'server_password'), 'generated-password');
        for (const line of lines) options.onLine?.(line);
        return done({ id: 'actual', action: 'enable', restart: [], mcp: [] }, lines);
      }
      if (script === 'addon.sh' && cmd === 'disable') {
        stack.setEnv({ ACTUAL_MCP_ENABLED: '0', ACTUAL_LOCAL_ENABLED: '0' });
        return done({ id: 'actual', action: 'disable', restart: [], mcp: [] });
      }
      if (script === 'addon.sh' && cmd === 'remove') {
        if (stack.env().ACTUAL_MCP_ENABLED === '1') return error('bad_input', 'actual is enabled; disable it first');
        fs.rmSync(store, { recursive: true, force: true });
        return done({ id: 'actual', action: 'remove', restart: [], mcp: [] });
      }
      if (script === 'addon.sh' && cmd === 'disconnect') {
        const slug = args[args.indexOf('--instance') + 1]!;
        if (!stack.rows().includes(slug)) return error('not_found', `actual has no instance ${slug}`);
        fs.rmSync(path.join(store, 'instances', `${slug}.json`));
        return done({ id: 'actual', action: 'disconnect', restart: [], mcp: [] });
      }
      if (script === 'addon.sh' && cmd === 'connect') {
        const slug = args[args.indexOf('--instance') + 1]!;
        if (!input) return error('bad_input', 'stdin is not a JSON object');
        const unknown = Object.keys(input).find((k) => !CONNECT_KEYS.has(k));
        if (unknown) return error('bad_input', `${unknown}: unknown setting`);
        const problem = input.bind === undefined ? null : bindProblem(input.bind);
        if (problem) return error('bad_input', `bind: ${problem}`);
        if (stack.rows().includes(slug)) return error('exists', `actual already has an instance ${slug}`);
        if (!/^[a-z][a-z0-9-]{0,30}$/.test(slug)) return error('bad_slug', 'slug must be 1-31 characters', 'check');
        if (!input.sync_id) return error('no_access', 'no budget sync id given', 'check');
        const server = signIn(String(input.server));
        if ('kind' in server) return { ...server, step: 'check' } as AddonScriptOutcome;
        const budget = server.budgets.find((b) => b.syncId === input.sync_id);
        if (!budget) return error('no_access', 'this account can’t open that budget', 'check');
        if (budget.encrypted && input.encryption_password !== budget.encrypted) {
          return error('encryption_password', 'the budget’s encryption password is missing or wrong', 'check');
        }
        stack.addRow(slug, { server: input.server, sync_id: input.sync_id, ...(input.bind ? { bind: input.bind } : {}) });
        return done({ id: 'actual', action: 'connect', restart: [], mcp: [`budget-${slug}`], account: slug });
      }
      return { kind: 'exited', code: 2, logTail: [`fake: no ${script} ${args.join(' ')}`], lines: [] };
    },
  };
  return stack;
}
