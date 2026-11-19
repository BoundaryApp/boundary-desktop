import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddonFit } from '../../../../shared/addonFit';
import { ADDON_LOCAL_REMOVE_MESSAGE, type AddonInstallSnapshot } from '../../../../shared/types/addons';
import { createEmailService, type EmailService } from '../emailAddon';
import { missingSettingsMessage } from '../../../../shared/emailAccount';
import { createEmailInstaller, type EmailInstaller } from '../emailInstaller';
import { createEmailFakeStack, type EmailFakeStack } from './emailFake';

let stack: EmailFakeStack;
let service: EmailService;
let installer: EmailInstaller;
let local: boolean;
let snapshots: AddonInstallSnapshot[];
let logs: { message: string; data: Record<string, unknown> }[];

const fits: AddonFit = { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 4096, suggestedEngineMiB: null };

beforeEach(() => {
  stack = createEmailFakeStack();
  local = false;
  snapshots = [];
  logs = [];
  const deps = {
    paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
    run: (script: 'addon.sh', args: string[], options?: Parameters<EmailFakeStack['run']>[2]) => stack.run(script, args, options),
    exclusive: <T,>(work: () => Promise<T>): Promise<T> => work(),
    log: (message: string, data: Record<string, unknown>): void => void logs.push({ message, data }),
  };
  service = createEmailService({
    ...deps,
    plain: (args, options) => stack.plain(args, options),
    indexerLog: async () => null,
    restartIndexer: async () => undefined,
    now: () => new Date('2026-11-11T10:00:00Z'),
  });
  installer = createEmailInstaller({ ...deps, service, checkFit: async () => fits, isLocalStack: () => local });
  installer.onChange((s) => snapshots.push(s));
});

afterEach(() => stack.cleanup());

const runs = () => stack.calls.filter((c) => c.kind === 'run').map((c) => c.args);

const statuses = (s: AddonInstallSnapshot | null) => s?.steps.map((step) => `${step.id}:${step.status}`);

const addAccount = (mailboxes: string[] = ['INBOX']): void => {
  stack.instances.home = {
    host: 'imap.example.com',
    port: 993,
    security: 'tls',
    user: 'pat@example.com',
    address: 'pat@example.com',
    mailboxes,
    password: 'right-password',
  };
};

describe('Get', () => {
  it('install runs check, enable and marks the first pass step done', async () => {
    addAccount();
    await installer.install('home');
    expect(runs()).toEqual([['enable', 'email', '--json']]);
    expect(statuses(installer.snapshot())).toEqual(['check:done', 'start:done', 'setup:done']);
    expect(installer.snapshot()?.done).toBe(true);
    // The setup line named the setup step while it ran.
    expect(snapshots.some((s) => s.steps.find((x) => x.id === 'setup')?.status === 'running')).toBe(true);
  });

  it('install that ends with missing_settings fails at start with the missing names', async () => {
    await installer.install('home');
    const snapshot = installer.snapshot();
    expect(snapshot?.error?.step).toBe('start');
    expect(snapshot?.error?.message).toBe('Couldn’t turn on email: an account.');
    expect(snapshot?.done).toBeFalsy();
  });

  it('an account without a password and no window are missing; empty mailboxes are not', async () => {
    addAccount([]);
    await installer.install('home');
    expect(installer.snapshot()?.done).toBe(true);

    delete stack.instances.home!.password;
    stack.settings.since = '';
    await installer.install('home');
    expect(installer.snapshot()?.error?.message).toBe('Couldn’t turn on email: the mail window, password for home.');
  });

  it('names each item of the stack’s message', () => {
    expect(missingSettingsMessage('missing settings: since, home.password')).toBe(
      'Couldn’t turn on email: the mail window, password for home.'
    );
    expect(missingSettingsMessage('missing settings: instances:accounts, other')).toBe('Couldn’t turn on email: an account, other.');
  });

  it('stops at the fit check when it doesn’t fit', async () => {
    addAccount();
    const over = createEmailInstaller({
      service,
      run: (script, args, options) => stack.run(script, args, options),
      paths: () => ({ root: stack.root, dataRoot: stack.dataRoot }),
      checkFit: async (): Promise<AddonFit> => ({ ...fits, verdict: 'over' }),
      isLocalStack: () => false,
      exclusive: (work) => work(),
      log: (): void => undefined,
    });
    await over.install('home');
    expect(over.snapshot()?.error?.step).toBe('check');
    expect(stack.calls.some((c) => c.args[0] === 'enable')).toBe(false);
  });

  it('refuses a run without a saved account name', async () => {
    await expect(installer.install('')).rejects.toThrow('Save an account');
    expect(stack.calls).toEqual([]);
  });

  it('logs the outcome without the account name', async () => {
    addAccount();
    await installer.install('home');
    expect(JSON.stringify(logs)).not.toContain('home');
  });
});

describe('Turn off, undo and start', () => {
  it('undo disables and keeps the account', async () => {
    addAccount();
    await installer.install('home');
    stack.setEnabled(true, true);
    await installer.undo();
    expect(runs().at(-1)).toEqual(['disable', 'email', '--json']);
    expect(Object.keys(stack.instances)).toEqual(['home']);
    expect(installer.snapshot()).toBeNull();
  });

  it('turns off with disable, keeps accounts, and starts again with enable', async () => {
    addAccount();
    await installer.start();
    expect(runs().at(-1)).toEqual(['enable', 'email', '--json']);
    await installer.turnOff();
    expect(runs().at(-1)).toEqual(['disable', 'email', '--json']);
    expect(Object.keys(stack.instances)).toEqual(['home']);
  });

  it('Turn on names what is missing instead of the stack’s keys', async () => {
    addAccount();
    delete stack.instances.home.password;
    await expect(installer.start()).rejects.toThrow(/^Couldn’t turn on email: password for home\.$/);
  });
});

describe('Remove and delete data', () => {
  it('remove disables then deletes data, and is refused against a local stack', async () => {
    addAccount();
    stack.setEnabled(true);
    await installer.remove();
    expect(runs()).toEqual([
      ['disable', 'email', '--json'],
      ['remove', 'email', '--delete-data', '--json'],
    ]);
    expect(statuses(installer.snapshot())).toEqual(['stop:done', 'delete-data:done']);
    expect(stack.instances).toEqual({});

    local = true;
    stack.calls.length = 0;
    await expect(installer.remove()).rejects.toThrow(ADDON_LOCAL_REMOVE_MESSAGE);
    expect(runs()).toEqual([]);
  });

  it('remove while enabled runs disable first, and the stack refuses a delete without it', async () => {
    addAccount();
    stack.setEnabled(true);
    await installer.remove();
    expect(runs()[0]).toEqual(['disable', 'email', '--json']);
    expect(installer.snapshot()?.done).toBe(true);

    addAccount();
    stack.setEnabled(true);
    const outcome = await stack.run('addon.sh', ['remove', 'email', '--delete-data', '--json']);
    expect(outcome).toMatchObject({ kind: 'error', error: 'bad_input' });
    expect(Object.keys(stack.instances)).toEqual(['home']);
  });

  it('skips disable when email is already off', async () => {
    addAccount();
    await installer.remove();
    expect(runs()).toEqual([['remove', 'email', '--delete-data', '--json']]);
  });
});
