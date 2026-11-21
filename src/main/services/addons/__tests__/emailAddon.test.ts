import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEmailService,
  emailAccountInput,
  emailAvailable,
  emailSettingsInput,
  readEmailFlags,
  type EmailService,
} from '../emailAddon';
import type { EmailAccountInput } from '../../../../shared/types/addons';
import { stackFilesAt } from '../../stackHost/activeStack';
import { createEmailFakeStack, type EmailFakeStack } from './emailFake';

let stack: EmailFakeStack;
let service: EmailService;
let logs: { message: string; data: Record<string, unknown> }[];
let restarts: number;
let restartError: Error | null;
let indexerText: string | null;
let now: Date;

beforeEach(() => {
  stack = createEmailFakeStack();
  logs = [];
  restarts = 0;
  restartError = null;
  indexerText = null;
  now = new Date('2026-11-11T10:00:00Z');
  service = createEmailService({
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    plain: (args, options) => stack.plain(args, options),
    run: (script, args, options) => stack.run(script, args, options),
    indexerLog: async () => indexerText,
    restartIndexer: async () => {
      restarts += 1;
      if (restartError) throw restartError;
    },
    exclusive: (work) => work(),
    now: () => now,
    log: (message, data) => logs.push({ message, data }),
  });
});

afterEach(() => stack.cleanup());

const good: EmailAccountInput = {
  slug: 'work',
  host: 'imap.example.com',
  port: 993,
  security: 'tls',
  user: 'pat@example.com',
  address: 'pat@example.com',
  password: 'right-password',
};

describe('emailAccountInput', () => {
  it('refuses plain on a public host', () => {
    expect(() => emailAccountInput({ ...good, security: 'plain' })).toThrow(/localhost/);
    expect(emailAccountInput({ ...good, host: 'localhost', security: 'plain' }).security).toBe('plain');
  });
  it('refuses a bad slug', () => {
    expect(() => emailAccountInput({ ...good, slug: 'Work' })).toThrow(/lowercase/);
  });
  it('refuses a port of 0', () => {
    expect(() => emailAccountInput({ ...good, port: 0 })).toThrow(/port/);
  });
  it('refuses a password with a line break', () => {
    expect(() => emailAccountInput({ ...good, password: 'a\nb' })).toThrow(/line break/);
    expect(() => emailAccountInput({ ...good, password: 'a\rb' })).toThrow(/line break/);
  });
  it('accepts a null password and refuses other types', () => {
    expect(emailAccountInput({ ...good, password: null }).password).toBeNull();
    expect(() => emailAccountInput({ ...good, password: 5 })).toThrow(/password/);
  });
  it('refuses an empty host, user and address and an unknown security', () => {
    expect(() => emailAccountInput({ ...good, host: ' ' })).toThrow();
    expect(() => emailAccountInput({ ...good, user: '' })).toThrow();
    expect(() => emailAccountInput({ ...good, address: '' })).toThrow();
    expect(() => emailAccountInput({ ...good, security: 'ssl' })).toThrow();
  });
});

describe('emailSettingsInput', () => {
  it('takes a real date and refuses others', () => {
    expect(emailSettingsInput({ since: '2026-08-13', attachments: false, drafts: true }).since).toBe('2026-08-13');
    expect(() => emailSettingsInput({ since: '2026-13-01', attachments: false, drafts: false })).toThrow();
    expect(() => emailSettingsInput({ since: '2026-02-30', attachments: false, drafts: false })).toThrow();
    expect(() => emailSettingsInput({ since: 'last week', attachments: false, drafts: false })).toThrow();
  });
});

describe('emailAvailable and flags', () => {
  it('needs addon.sh and a manifest with accounts and a mailboxes command', async () => {
    expect(await emailAvailable(stackFilesAt(stack.root))).toBe(true);
    fs.writeFileSync(path.join(stack.root, 'addons', 'email', 'addon.json'), JSON.stringify({ instances: { name: 'accounts' } }));
    expect(await emailAvailable(stackFilesAt(stack.root))).toBe(false);
    fs.rmSync(path.join(stack.root, 'scripts', 'addon.sh'));
    expect(await emailAvailable(stackFilesAt(stack.root))).toBe(false);
  });
  it('reads the flags from .env', async () => {
    expect(await readEmailFlags(stackFilesAt(stack.root))).toEqual({ enabled: false, drafts: false });
    stack.setEnabled(true, true);
    expect(await readEmailFlags(stackFilesAt(stack.root))).toEqual({ enabled: true, drafts: true });
  });
});

describe('saveAccount', () => {
  it('keeps a password with quotes and unicode out of argv and logs', async () => {
    const password = 'a"b\\c ünï';
    expect(await service.saveAccount({ ...good, password })).toEqual({ ok: true });
    const call = stack.calls.find((c) => c.args[0] === 'configure')!;
    expect(call.args).toEqual(['configure', 'email', '--instance', 'work']);
    expect(JSON.parse(JSON.stringify(call.input)).password).toBe(password);
    expect(JSON.stringify(stack.calls.map((c) => c.args))).not.toContain('ünï');
    expect(JSON.stringify(logs)).not.toContain('ünï');
    expect(JSON.stringify(logs)).not.toContain('work');
    expect(JSON.stringify(logs)).not.toContain('example.com');
  });

  it('with password null sends no password key', async () => {
    await service.saveAccount({ ...good, password: null });
    const call = stack.calls.find((c) => c.args[0] === 'configure')!;
    expect(call.input).toEqual({ host: 'imap.example.com', port: 993, security: 'tls', user: 'pat@example.com', address: 'pat@example.com' });
    expect('password' in call.input!).toBe(false);
  });

  it('exit 1 with busy maps to the busy failure', async () => {
    stack.override = () => ({ code: 1, stdout: '', stderrTail: ['error: another add-on change is running (pid 4242)'] });
    expect(await service.saveAccount(good)).toEqual({
      ok: false,
      error: 'busy',
      message: 'Another add-on change is running. Try again in a moment.',
    });
  });

  it('a stale lock file maps to busy; any other exit 1 is a generic failure with its error line', async () => {
    stack.override = () => ({ code: 1, stdout: '', stderrTail: ['error: /x/lock exists and is not a lock symlink; remove it if no add-on change is running'] });
    expect(await service.saveAccount(good)).toMatchObject({ ok: false, error: 'busy' });
    stack.override = () => ({ code: 1, stdout: '', stderrTail: ['error: disk full', 'busy somewhere'] });
    expect(await service.saveAccount(good)).toEqual({ ok: false, error: 'command_failed', message: 'disk full' });
  });

  it('a new password for an account with mailboxes restarts the indexer while email is on', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    await service.saveAccount({ ...good, password: 'next-password' });
    expect(restarts).toBe(0);
    stack.setEnabled(true);
    await service.saveAccount({ ...good, password: null });
    expect(restarts).toBe(0);
    await service.saveAccount({ ...good, password: 'next-password' });
    expect(restarts).toBe(1);
    // No mailboxes yet: the indexer leaves it out, so there is nothing to restart for.
    await service.saveAccount({ ...good, slug: 'home', password: 'next-password' });
    expect(restarts).toBe(1);
  });

  it('exit 2 maps to bad_input with the error line, not the synopsis after it', async () => {
    stack.override = () => ({ code: 2, stdout: '', stderrTail: ['error: host is not allowed', 'usage: addon.sh configure <addon> [--instance S]'] });
    expect(await service.saveAccount(good)).toEqual({ ok: false, error: 'bad_input', message: 'host is not allowed' });
  });
});

describe('listMailboxes', () => {
  beforeEach(async () => {
    await service.saveAccount(good);
  });

  it('maps the indented JSON array to mailboxes with special-use flags', async () => {
    const result = await service.listMailboxes('work');
    expect(result).toEqual({
      ok: true,
      mailboxes: [
        { name: 'INBOX', messages: 40, specialUse: [] },
        { name: 'Sent Messages', messages: 12, specialUse: ['\\sent'] },
        { name: 'Junk', messages: 3, specialUse: ['\\junk'] },
        { name: 'Projects/Alpha', messages: 7, specialUse: [] },
      ],
    });
    const call = stack.calls.find((c) => c.args[0] === 'run')!;
    expect(call.args).toEqual(['run', 'email', 'mailboxes', '--instance', 'work']);
    expect(JSON.stringify(logs)).not.toContain('Projects');
  });

  it('maps a refused login to login_refused with the stack’s line', async () => {
    await service.saveAccount({ ...good, password: 'wrong' });
    expect(await service.listMailboxes('work')).toEqual({
      ok: false,
      error: 'login_refused',
      message: 'the server rejected the user name or password',
    });
  });

  it('maps a closed port to server_unreachable', async () => {
    stack.closedHosts.push('imap.example.com');
    const result = await service.listMailboxes('work');
    expect(result).toMatchObject({ ok: false, error: 'server_unreachable' });
  });

  it('maps an exit 4 with no mail-index line to listing_failed', async () => {
    stack.override = () => ({ code: 4, stdout: '', stderrTail: ['something else'] });
    expect(await service.listMailboxes('work')).toEqual({
      ok: false,
      error: 'listing_failed',
      message: 'addon.sh run exited with code 4',
    });
  });

  it('keeps the stack’s error line for an exit 2', async () => {
    stack.override = () => ({ code: 2, stdout: '', stderrTail: ['error: no such account', 'usage: addon.sh run ...'] });
    expect(await service.listMailboxes('work')).toEqual({ ok: false, error: 'listing_failed', message: 'no such account' });
  });

  it('takes an email-addon line too', async () => {
    stack.override = () => ({ code: 4, stdout: '', stderrTail: ['email-addon: no such account'] });
    expect(await service.listMailboxes('work')).toEqual({ ok: false, error: 'listing_failed', message: 'no such account' });
  });
});

describe('removeNewAccount', () => {
  it('runs configure --remove only for an account with no mailboxes', async () => {
    await service.saveAccount(good);
    await service.removeNewAccount('work');
    expect(stack.instances.work).toBeUndefined();
    expect(stack.calls.at(-1)!.args).toEqual(['configure', 'email', '--instance', 'work', '--remove']);

    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    const before = stack.calls.length;
    await service.removeNewAccount('work');
    expect(stack.instances.work).toBeDefined();
    expect(stack.calls.slice(before).some((c) => c.args.includes('--remove'))).toBe(false);
  });

  it('drops the account from the overview it emits', async () => {
    await service.saveAccount(good);
    expect((await service.refresh()).accounts.map((a) => a.slug)).toEqual(['work']);
    const seen: string[][] = [];
    service.onChange((o) => seen.push(o.accounts.map((a) => a.slug)));
    await service.removeNewAccount('work');
    expect(seen.at(-1)).toEqual([]);
    expect((await service.overview()).accounts).toEqual([]);
  });
});

describe('setMailboxes', () => {
  it('restarts the indexer only while email is on', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX', 'Sent Messages']);
    expect(stack.instances.work.mailboxes).toEqual(['INBOX', 'Sent Messages']);
    expect(restarts).toBe(0);
    stack.setEnabled(true);
    await service.setMailboxes('work', ['INBOX']);
    expect(restarts).toBe(1);
  });
});

describe('removeAccount', () => {
  it('removes, then restarts the indexer while email is on', async () => {
    await service.saveAccount(good);
    stack.setEnabled(true);
    expect(await service.removeAccount('work')).toEqual({ ok: true });
    expect(restarts).toBe(1);
    expect(stack.instances.work).toBeUndefined();
  });

  it('drops the account from the overview it emits', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    await service.refresh();
    const seen: string[][] = [];
    service.onChange((o) => seen.push(o.accounts.map((a) => a.slug)));
    await service.removeAccount('work');
    expect(seen.at(-1)).toEqual([]);
  });

  it('a restart that fails after the account is removed still answers ok and logs no values', async () => {
    await service.saveAccount(good);
    stack.setEnabled(true);
    restartError = new Error('compose failed for imap.example.com');
    expect(await service.removeAccount('work')).toEqual({ ok: true });
    expect(logs.some((l) => l.message === 'restart-indexer' && l.data.ok === false)).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/work|example\.com|compose failed/);
  });
});

describe('a failed restart', () => {
  it('leaves setMailboxes, a password change and setSettings ok', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    stack.setEnabled(true);
    restartError = new Error('compose failed');
    expect(await service.setMailboxes('work', ['INBOX'])).toEqual({ ok: true });
    expect(await service.saveAccount(good)).toEqual({ ok: true });
    expect(await service.setSettings({ since: '2026-01-01', attachments: false, drafts: false })).toEqual({ ok: true });
    expect(restarts).toBe(3);
  });
});

describe('pass owed', () => {
  it('stays owed through the pass running at the change and clears once the account leaves waiting', async () => {
    stack.setEnabled(true);
    await service.saveAccount(good);
    // The pass that began at 09:58 ends while the restart stops the indexer, so the log read
    // after the restart already has it.
    const running = '2026-11-11T10:00:05Z {"in_scope": 3, "failed": {}}';
    indexerText = ['2026-11-11T09:43:00Z {"in_scope": 3, "failed": {}}', running].join('\n');
    await service.setMailboxes('work', ['INBOX']);
    expect(restarts).toBe(1);

    let o = await service.refresh();
    expect(o.accounts[0].state).toBe('waiting');
    expect(o.passOwed).toBe(true);

    indexerText = [indexerText, '2026-11-11T10:01:00Z {"in_scope": 4, "failed": {}}'].join('\n');
    o = await service.refresh();
    expect(o.accounts[0].state).toBe('indexed');
    expect(o.passOwed).toBe(false);
  });

  it('is not owed for an account the next pass leaves out or fails', async () => {
    stack.setEnabled(true);
    await service.saveAccount(good);
    indexerText = '';
    await service.setMailboxes('work', ['INBOX']);
    indexerText = '2026-11-11T10:01:00Z {"in_scope": 0, "failed": {"work": 4}, "error": "4"}';
    const o = await service.refresh();
    expect(o.accounts[0].state).toBe('login_refused');
    expect(o.passOwed).toBe(false);
  });
});

describe('setSettings', () => {
  const base = { since: '2026-08-13', attachments: false, drafts: false };

  it('always sends bodies true, runs enable when drafts changed, and restarts the indexer when only the window changed', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    stack.setEnabled(true, false);

    await service.setSettings({ ...base, drafts: true });
    const configure = stack.calls.filter((c) => c.args[0] === 'configure').at(-1)!;
    expect(configure.args).toEqual(['configure', 'email']);
    expect(configure.input).toEqual({ since: '2026-08-13', bodies: true, attachments: false, drafts: true });
    expect(stack.calls.at(-1)).toMatchObject({ kind: 'run', args: ['enable', 'email', '--json'] });
    expect((await readEmailFlags(stackFilesAt(stack.root))).drafts).toBe(true);
    expect(restarts).toBe(0);

    await service.setSettings({ since: '2026-01-01', attachments: false, drafts: true });
    expect(restarts).toBe(1);
    expect(stack.calls.filter((c) => c.kind === 'run')).toHaveLength(1);

    // Drafts and the window together: enable runs and the indexer is restarted too.
    await service.setSettings({ since: '2026-02-01', attachments: false, drafts: false });
    expect(stack.calls.filter((c) => c.kind === 'run')).toHaveLength(2);
    expect(restarts).toBe(2);

    await service.setSettings({ since: '2026-02-01', attachments: false, drafts: false });
    expect(restarts).toBe(2);
  });

  it('does not restart or enable while email is off', async () => {
    await service.setSettings({ ...base, since: '2026-01-01', drafts: true });
    expect(restarts).toBe(0);
    expect(stack.calls.some((c) => c.kind === 'run')).toBe(false);
  });

  it('a drafts-only change marks no account as changed', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    stack.setEnabled(true);
    indexerText = '2026-11-11T10:05:00Z {"in_scope": 1, "failed": {}}';
    expect((await service.refresh()).accounts[0].state).toBe('indexed');
    now = new Date('2026-11-11T10:30:00Z');
    await service.setSettings({ ...base, drafts: true });
    const o = await service.refresh();
    expect(o.accounts[0].state).toBe('indexed');
    expect(o.passOwed).toBe(false);
  });

  it('marks every account as changed, so a pass is owed', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    stack.setEnabled(true);
    indexerText = '2026-11-11T09:00:00Z {"in_scope": 1, "failed": {}}';
    now = new Date('2026-11-11T10:30:00Z');
    await service.setSettings({ ...base, attachments: true });
    const o = await service.refresh();
    expect(o.passOwed).toBe(true);
    expect(o.accounts[0].state).toBe('waiting');
  });
});

describe('refresh', () => {
  it('builds rows from list --json and the indexer log, and logs counts only', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    await service.saveAccount({ ...good, slug: 'old', address: 'sam@example.com', user: 'sam@example.com' });
    stack.setEnabled(true, true);
    indexerText = [
      '2026-11-11T11:00:00Z email-indexer: old: mailbox is empty',
      '2026-11-11T11:00:01Z {"in_scope": 2, "failed": {}}',
    ].join('\n');
    now = new Date('2026-11-11T12:00:00Z');
    logs.length = 0;

    const o = await service.refresh();
    expect(o).toMatchObject({
      available: true,
      enabled: true,
      drafts: true,
      since: '2026-08-13',
      attachments: false,
      lastPass: { at: '2026-11-11T11:00:01Z', inScope: 2 },
      readError: null,
    });
    const work = o.accounts.find((a) => a.slug === 'work')!;
    expect(work).toMatchObject({ host: 'imap.example.com', passwordSet: true, mailboxes: ['INBOX'] });
    // Boundary changed it at 10:00, before the 11:00 pass.
    expect(work.state).toBe('indexed');
    expect(o.accounts.find((a) => a.slug === 'old')!.state).toBe('left_out');
    expect(o.passOwed).toBe(false);

    const text = JSON.stringify(logs);
    expect(logs.map((l) => l.message)).toEqual(['refresh']);
    expect(text).not.toMatch(/work|old|example\.com|INBOX|empty/);
    expect(logs[0].data).toMatchObject({ read: true, accounts: 2, enabled: true });
  });

  it('reports a list that fails as readError and keeps the last rows and indexer log', async () => {
    await service.saveAccount(good);
    stack.setEnabled(true);
    indexerText = '2026-11-11T11:00:01Z {"in_scope": 1, "failed": {}}';
    now = new Date('2026-11-11T09:00:00Z');
    const first = await service.refresh();
    expect(first.accounts[0].state).toBe('indexed');
    stack.override = () => ({ code: 1, stdout: '', stderrTail: [] });
    const o = await service.refresh();
    expect(o.readError).toBe('addon.sh list exited with code 1');
    expect(o.accounts).toHaveLength(1);
    expect(o.accounts[0].state).toBe('indexed');
    expect(o.lastPass).not.toBeNull();
  });

  it('keeps the previous indexer log when the log read fails', async () => {
    await service.saveAccount(good);
    stack.setEnabled(true);
    indexerText = '2026-11-11T11:00:01Z {"in_scope": 1, "failed": {}}';
    now = new Date('2026-11-11T09:00:00Z');
    await service.refresh();
    indexerText = null;
    const o = await service.refresh();
    expect(o.accounts[0].state).toBe('indexed');
    expect(o.lastPass).not.toBeNull();
  });

  it('shows password and tls_ca as set flags in the fake list, and removing an unknown slug is a no-op', async () => {
    await service.saveAccount({ ...good, password: null });
    const o = await service.refresh();
    expect(o.accounts[0].passwordSet).toBe(false);
    expect(await service.removeAccount('nobody')).toEqual({ ok: true });
  });

  it('notifies onChange listeners until they unsubscribe', async () => {
    const seen: number[] = [];
    const off = service.onChange((o) => seen.push(o.accounts.length));
    await service.refresh();
    expect(seen.length).toBeGreaterThan(0);
    off();
    const n = seen.length;
    await service.refresh();
    expect(seen.length).toBe(n);
  });
});

describe('enable', () => {
  it('runs addon.sh enable email --json and passes lines on', async () => {
    await service.saveAccount(good);
    await service.setMailboxes('work', ['INBOX']);
    const lines: string[] = [];
    const outcome = await service.enable({ onLine: (l) => lines.push(l.phase) });
    expect(outcome.kind).toBe('done');
    expect(lines).toEqual(['setup']);
    expect(stack.calls.at(-1)!.args).toEqual(['enable', 'email', '--json']);
  });
});
