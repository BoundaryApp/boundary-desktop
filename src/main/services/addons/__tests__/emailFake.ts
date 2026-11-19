import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddonScriptLine, AddonScriptOutcome, PlainOutcome } from '../addonScript';

// A fake of the stack's email add-on (v0.3.13), as far as Boundary relies on it:
//
// - addon.sh configure email [--instance S] [--remove], stdin JSON. Exit 0 with no output;
//   removing an unknown slug is a no-op. Exit 2 with an `error: ...` line (then a synopsis) for
//   a bad value; exit 1 with `error: another add-on change is running (pid N)` on stderr while
//   another change holds the stack lock. The settings call writes EMAIL_DRAFTS_ENABLED itself
//   while email is on. Instance keys: host, port, security, user, address,
//   mailboxes; password is stored apart; list shows password and tls_ca as {set: bool}.
// - addon.sh list --json: an array of add-ons; the `email` entry has shortId, settings
//   {since, bodies, attachments, drafts} and instances (slug -> values).
// - addon.sh run email mailboxes --instance S: one indented JSON array of
//   {account, mailbox, messages, special_use}; exit 4 with a `mail-index: ...` stderr line when
//   the login is refused or the port is closed.
// - addon.sh disable email --json: EMAIL_ENABLED=0 and EMAIL_DRAFTS_ENABLED=0; setup lines for
//   flags, stop and reload (running, then done); then a `done` line.
// - addon.sh remove email --delete-data --json: refuses with `bad_input` while EMAIL_ENABLED=1;
//   otherwise deletes the whole add-on (accounts, settings, secrets), then a `done` line.
// - addon.sh enable email --json: EMAIL_ENABLED=1 (and EMAIL_DRAFTS_ENABLED from the stored
//   drafts setting), then a `done` line; `error` with missing_settings (step flags, message
//   `missing settings: <names>`, exit 3 in the stack) when `since` is unset, there is no account or
//   an account has no password. An empty mailboxes list is not missing.
//
// All data is synthetic.

const FAKE_MAILBOXES = [
  { mailbox: 'INBOX', messages: 40, special_use: [] as string[] },
  { mailbox: 'Sent Messages', messages: 12, special_use: ['\\sent'] },
  { mailbox: 'Junk', messages: 3, special_use: ['\\junk'] },
  { mailbox: 'Projects/Alpha', messages: 7, special_use: [] as string[] },
];

interface FakeInstance {
  host: string;
  port: number;
  security: string;
  user: string;
  address: string;
  mailboxes?: string[];
  password?: string;
}

export interface EmailFakeStack {
  root: string;
  dataRoot: string;
  /** Every call, with its stdin. */
  calls: { kind: 'plain' | 'run'; args: string[]; input?: Record<string, unknown> }[];
  instances: Record<string, FakeInstance>;
  settings: { since: string; bodies: boolean; attachments: boolean; drafts: boolean };
  /** The next plain call that matches answers with this outcome instead. */
  override: ((args: string[]) => PlainOutcome | null) | null;
  /** The login password the fake server accepts; any other is refused. */
  serverPassword: string;
  /** Hosts whose port is closed. */
  closedHosts: string[];
  plain(args: string[], options?: { input?: Record<string, unknown> }): Promise<PlainOutcome>;
  run(
    script: 'addon.sh',
    args: string[],
    options?: { onLine?: (l: AddonScriptLine) => void }
  ): Promise<AddonScriptOutcome>;
  setEnabled(enabled: boolean, drafts?: boolean): void;
  cleanup(): void;
}

const plainOut = (code: number, stdout = '', stderrTail: string[] = []): PlainOutcome => ({ code, stdout, stderrTail });

export function createEmailFakeStack(): EmailFakeStack {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-fake-'));
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'addons', 'email'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '#!/bin/bash\n');
  fs.writeFileSync(
    path.join(root, 'addons', 'email', 'addon.json'),
    JSON.stringify({ instances: { name: 'accounts' }, commands: { mailboxes: {} } })
  );
  fs.writeFileSync(path.join(root, '.env'), '');

  const writeEnv = (enabled: boolean, drafts: boolean): void => {
    fs.writeFileSync(path.join(root, '.env'), `EMAIL_ENABLED=${enabled ? 1 : 0}\nEMAIL_DRAFTS_ENABLED=${drafts ? 1 : 0}\n`);
  };

  const readEnabled = (): boolean => /^EMAIL_ENABLED=1$/m.test(fs.readFileSync(path.join(root, '.env'), 'utf8'));

  const stack: EmailFakeStack = {
    root,
    dataRoot,
    calls: [],
    instances: {},
    settings: { since: '2026-08-13', bodies: true, attachments: false, drafts: false },
    override: null,
    serverPassword: 'right-password',
    closedHosts: [],

    async plain(args, options = {}) {
      stack.calls.push({ kind: 'plain', args, input: options.input });
      if (stack.override) {
        const answer = stack.override(args);
        if (answer) return answer;
      }
      const [cmd, what] = args;
      if (cmd === 'list' && args.includes('--json')) {
        const instances: Record<string, unknown> = {};
        for (const [slug, i] of Object.entries(stack.instances)) {
          const { password, ...rest } = i;
          instances[slug] = { ...rest, password: { set: Boolean(password) }, tls_ca: { set: false } };
        }
        return plainOut(0, JSON.stringify([{ shortId: 'twenty' }, { shortId: 'email', settings: stack.settings, instances }], null, 2));
      }
      if (cmd === 'configure' && what === 'email') {
        const at = args.indexOf('--instance');
        const slug = at >= 0 ? args[at + 1] : null;
        const input = options.input ?? {};
        if (slug === null) {
          const since = input.since;
          if (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
            return plainOut(2, '', ['error: since must be YYYY-MM-DD']);
          }
          stack.settings = {
            since,
            bodies: input.bodies === true,
            attachments: input.attachments === true,
            drafts: input.drafts === true,
          };
          // cmd_configure writes the flag itself while email is on.
          if (readEnabled()) writeEnv(true, stack.settings.drafts);
          return plainOut(0);
        }
        if (args.includes('--remove')) {
          // remove_instance is a no-op for an unknown slug.
          delete stack.instances[slug];
          return plainOut(0);
        }
        const current = stack.instances[slug];
        // apply_instance merges over the stored instance; check_instance runs only on connect.
        stack.instances[slug] = { ...(current ?? ({} as FakeInstance)), ...(input as Partial<FakeInstance>) };
        return plainOut(0);
      }
      if (cmd === 'run' && what === 'email' && args[2] === 'mailboxes') {
        const slug = args[args.indexOf('--instance') + 1];
        const account = stack.instances[slug];
        if (!account) return plainOut(2, '', [`error: no such account: ${slug}`]);
        if (stack.closedHosts.includes(account.host)) {
          return plainOut(4, '', [`mail-index: can't connect to ${account.host}:${account.port}`]);
        }
        if (account.password !== stack.serverPassword) {
          return plainOut(4, '', ['mail-index: the server rejected the user name or password']);
        }
        return plainOut(0, JSON.stringify(FAKE_MAILBOXES.map((m) => ({ account: slug, ...m })), null, 2));
      }
      return plainOut(2, '', [`error: unknown command ${args.join(' ')}`]);
    },

    async run(_script, args, options = {}) {
      stack.calls.push({ kind: 'run', args });
      if (args[0] === 'enable' && args[1] === 'email') {
        // cmd_plan_enable: addon_store.missing names a required setting that isn't stored
        // (since), the instances (`instances:accounts`) and an instance's unset secret
        // (`<slug>.password`). An empty mailboxes list counts as stored.
        const missing: string[] = [];
        if (!stack.settings.since) missing.push('since');
        if (Object.keys(stack.instances).length === 0) missing.push('instances:accounts');
        for (const [slug, i] of Object.entries(stack.instances)) if (!i.password) missing.push(`${slug}.password`);
        if (missing.length) {
          return {
            kind: 'error',
            error: 'missing_settings',
            message: `missing settings: ${missing.join(', ')}`,
            step: 'flags',
            logTail: [],
            lines: [],
          };
        }
        writeEnv(true, stack.settings.drafts);
        const line: AddonScriptLine = { phase: 'setup', step: 'reload', status: 'running' };
        options.onLine?.(line);
        return { kind: 'done', done: { phase: 'done' }, lines: [line] };
      }
      if (args[0] === 'disable' && args[1] === 'email') {
        writeEnv(false, false);
        // run_step prints a running and a done line for each of flags, stop and reload.
        const lines: AddonScriptLine[] = ['flags', 'stop', 'reload'].flatMap((step) => [
          { phase: 'setup', step, status: 'running' },
          { phase: 'setup', step, status: 'done' },
        ]);
        for (const line of lines) options.onLine?.(line);
        return { kind: 'done', done: { phase: 'done' }, lines };
      }
      if (args[0] === 'remove' && args[1] === 'email' && args.includes('--delete-data')) {
        if (readEnabled()) {
          return { kind: 'error', error: 'bad_input', message: 'email is enabled; disable it first', step: null, logTail: [], lines: [] };
        }
        // Deletes the whole add-on: accounts, settings and secrets.
        stack.instances = {};
        stack.settings = { since: '', bodies: false, attachments: false, drafts: false };
        return { kind: 'done', done: { phase: 'done' }, lines: [] };
      }
      return { kind: 'exited', code: 2, logTail: ['error: unknown command'], lines: [] };
    },

    setEnabled(enabled, drafts = false) {
      writeEnv(enabled, drafts);
    },

    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return stack;
}
