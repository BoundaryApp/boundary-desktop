import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonInstallSnapshot } from '../../../../shared/types/addons';
import { ACTUAL_ENTRY, BITWARDEN_ENTRY, EMAIL_ENTRY, TWENTY_ENTRY } from '../addonCatalog';
import { captureIpcHandlers } from '../../__tests__/captureIpcHandlers';

const h = vi.hoisted(() => ({
  installer: {
    install: vi.fn(async () => undefined),
    undo: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    turnOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    remove: vi.fn(async (_id: string, _opts: unknown) => undefined),
    snapshot: vi.fn(() => null),
    onChange: vi.fn((_cb: (s: unknown) => void) => (): void => undefined),
  },
  root: { root: '/stack' } as { root: string | null; error?: string },
  localStack: { value: false },
  phase: { value: 'ready' as string },
  available: vi.fn(),
  installed: vi.fn((_root: string) => [] as string[]),
  broadcast: vi.fn(),
  ps: vi.fn(async (_args: string[], _opts: unknown) => ({ stdout: '', stderr: '' })),
  readFacts: vi.fn(),
  reload: vi.fn(async () => ({ success: true })),
  pending: ['Connect work'] as string[],
  pendingCb: null as null | ((l: string[]) => void),
  apply: vi.fn(async (reload: () => Promise<unknown>) => {
    await reload();
  }),
  exclusive: vi.fn(<T,>(work: () => Promise<T>) => work()),
  open: vi.fn(async (_url: string) => undefined),
  link: vi.fn(async (_deps: unknown) => ({ url: 'http://localhost:3000/verify?loginToken=TOK', signedIn: true }) as { url: string; signedIn: boolean; warning?: string }),
  copy: vi.fn((_deps: unknown) => true),
  debugLog: vi.fn((_area: string, _message: string, _data?: Record<string, unknown>) => undefined),
  email: {
    saveAccount: vi.fn(async (_input: unknown) => ({ ok: true }) as unknown),
    setMailboxes: vi.fn(async (_slug: string, _boxes: string[]) => ({ ok: true }) as unknown),
    removeNewAccount: vi.fn(async (_slug: string) => undefined),
    removeAccount: vi.fn(async (_slug: string) => ({ ok: true }) as unknown),
    listMailboxes: vi.fn(async (_slug: string) => ({ ok: true, mailboxes: [] }) as unknown),
    setSettings: vi.fn(async (_input: unknown) => ({ ok: true }) as unknown),
    overview: vi.fn(() => ({ accounts: [] })),
    refresh: vi.fn(async () => ({ accounts: [] })),
    onChange: vi.fn((_cb: (o: unknown) => void) => (): void => undefined),
  },
  twenty: {
    listWorkspaces: vi.fn(() => [{ slug: 'work' }]),
    connect: vi.fn(async (_input: unknown) => ({ ok: true, checks: [] })),
    disconnect: vi.fn(async (_slug: string) => undefined),
    setAccess: vi.fn(async (_slug: string, _access: string) => undefined),
  },
}));

vi.mock('../addonInstaller', () => ({
  getAddonInstaller: () => h.installer,
  runExclusive: (work: () => Promise<unknown>) => h.exclusive(work),
}));
vi.mock('electron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('electron')>()),
  ipcMain: { handle: vi.fn() },
  app: { on: vi.fn(), off: vi.fn() },
  shell: { openExternal: (url: string) => h.open(url) },
  clipboard: { writeText: vi.fn(), readText: vi.fn() },
}));
vi.mock('../twentySignIn', () => ({
  twentyLoginLink: (deps: unknown) => h.link(deps),
  twentyPort: async () => 3456,
  copyOwnerPassword: (deps: unknown) => h.copy(deps),
}));
vi.mock('../../stackHost/activeStack', async () => {
  const { localStackEndpoints, localStackFiles } = await import('../../stackHost/localStackHost');
  const { DEFAULT_ASSISTANT_STACK_PORTS } = await import('../../../../shared/assistantStackConstants');
  return {
    getStackEndpoints: () => localStackEndpoints(() => DEFAULT_ASSISTANT_STACK_PORTS),
    getStackFiles: () => ({}),
    stackFilesAt: (stackRoot: string) => localStackFiles({ stackRoot, userContentRoot: () => `${stackRoot}/data` }),
  };
});
vi.mock('../emailRuntime', () => ({ getEmailService: () => h.email }));
vi.mock('../twentyService', () => ({ getTwentyService: () => h.twenty }));
vi.mock('../addonCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addonCatalog')>()),
  availableAddons: (...a: unknown[]) => h.available(...a),
}));
vi.mock('../addonHostFacts', () => ({ readAddonHostFacts: h.readFacts }));
vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: () => ({ compose: h.ps }),
  getLocalStackPaths: () => ({ root: '/stack', dataRoot: '/stack/data' }),
  getAssistantStackLifecycle: () => ({ phase: h.phase.value }),
  reloadHermesForAddons: () => h.reload(),
}));
vi.mock('../pendingRestart', () => ({
  pendingChanges: () => h.pending,
  applyPendingChanges: (r: () => Promise<unknown>) => h.apply(r),
  onPendingChanges: (cb: (l: string[]) => void) => {
    h.pendingCb = cb;
    return (): void => undefined;
  },
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({
  tryResolveAssistantRoot: () => h.root,
}));
vi.mock('../../assistant/AssistantStackStore', () => ({
  getInstalledAddons: (root: string) => h.installed(root),
}));
vi.mock('../../assistant/localStackMode', () => ({
  isLocalAssistantStackMode: () => h.localStack.value,
}));
vi.mock('../../runningWork', () => ({ runningWork: vi.fn(async () => [{ id: 'turn:1' }]) }));
vi.mock('../../windows', () => ({ broadcast: h.broadcast }));
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog: h.debugLog }));

const { handler } = captureIpcHandlers();
const call = (channel: string, ...args: unknown[]) => handler(channel)({}, ...args) as Promise<unknown>;

const entry = TWENTY_ENTRY;

/** Port 3000 taken and 5400 MiB used of 8 GiB; Twenty's containers use 2500 MiB of that. */
const facts = {
  engineMiB: 8192,
  usedMiB: 5400,
  hostMiB: 32768,
  diskFreeBytes: 50_000_000_000,
  portInUse: true,
  engineResizable: false,
};
const readFacts = async (_entry: unknown, _deps: unknown, options?: { leftover?: boolean }) =>
  options?.leftover ? { ...facts, usedMiB: 2900, portInUse: false } : { ...facts };
let onChange: (s: unknown) => void;
let onEmailChange: (o: unknown) => void;

beforeAll(async () => {
  const { registerAddonHandlers } = await import('../ipcHandlers');
  registerAddonHandlers();
  onChange = h.installer.onChange.mock.calls[0]![0];
  onEmailChange = h.email.onChange.mock.calls[0]![0];
});

beforeEach(() => {
  vi.clearAllMocks();
  h.root = { root: '/stack' };
  h.localStack.value = false;
  h.phase.value = 'ready';
  h.available.mockReturnValue([]);
  h.installed.mockReturnValue([]);
  h.readFacts.mockImplementation(readFacts);
  h.ps.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('addon handlers', () => {
  it('lists nothing for a stack without add-ons', async () => {
    expect(await call('addons:list')).toEqual([]);
  });

  it('lists nothing when the stack root cannot be resolved', async () => {
    h.root.root = null;
    expect(await call('addons:list')).toEqual([]);
    expect(h.available).not.toHaveBeenCalled();
  });

  it('logs an unresolved root with its error', async () => {
    h.root = { root: null, error: 'docker-compose.yml was not found' };
    await call('addons:list');
    expect(h.debugLog).toHaveBeenCalledWith('addons', 'list: no stack root', expect.objectContaining({
      root: null,
      localStack: false,
      error: 'docker-compose.yml was not found',
    }));
  });

  it('logs the listed and installed ids, and nothing from the facts', async () => {
    h.localStack.value = true;
    h.available.mockReturnValue([entry]);
    h.installed.mockReturnValue(['twenty']);
    await call('addons:list');
    const [, message, data] = h.debugLog.mock.calls.find(([, m]) => m === 'list')!;
    expect(message).toBe('list');
    expect(data).toEqual({ root: '/stack', localStack: true, ms: expect.any(Number), ids: ['twenty'], installed: ['twenty'] });
  });

  describe('Bitwarden', () => {
    const writeTree = (root: string, manifest: unknown): void => {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'bitwarden'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(path.join(root, 'scripts', 'vault.sh'), '');
      fs.writeFileSync(path.join(root, 'addons', 'bitwarden', 'addon.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(root, '.env'), 'BITWARDEN_ENABLED=1\n');
    };

    it('lists Bitwarden as installed while the stack ships it and BITWARDEN_ENABLED is 1', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-bitwarden-'));
      try {
        writeTree(root, { instances: { connect: {}, disconnect: {} } });
        h.root = { root };
        h.available.mockReturnValue([BITWARDEN_ENTRY]);
        const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
        expect(listing.installed).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('never lists Bitwarden as installed when the stack’s manifest has no connect and disconnect', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-bitwarden-old-'));
      try {
        writeTree(root, { instances: {} });
        h.root = { root };
        h.available.mockReturnValue([BITWARDEN_ENTRY]);
        const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
        expect(listing.installed).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('logs a failed listing and still rejects', async () => {
    h.available.mockReturnValue([entry]);
    h.installed.mockImplementation(() => {
      throw new Error('store unreadable');
    });
    await expect(call('addons:list')).rejects.toThrow('store unreadable');
    expect(h.debugLog).toHaveBeenCalledWith('addons', 'list failed', expect.objectContaining({
      root: '/stack',
      error: 'store unreadable',
    }));
  });

  it('lists each available add-on with its installed flag, fit and facts', async () => {
    h.available.mockReturnValue([entry]);
    h.installed.mockReturnValue(['twenty']);
    const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
    expect(listing.entry).toEqual(entry);
    expect(listing.installed).toBe(true);
    expect(h.installed).toHaveBeenCalledWith('/stack');
    // Port 3000 is taken, and 2792 MiB free is tight for Twenty.
    expect(listing.fit).toEqual({
      verdict: 'over',
      memory: 'tight',
      disk: 'ok',
      port: 'over',
      freeMiB: 2792,
      suggestedEngineMiB: null,
    });
    expect(listing.facts).toMatchObject({ engineMiB: 8192 });
    expect(listing.canRemoveData).toBe(true);
    expect(listing.leftover).toBe(false);
    expect(listing.stopped).toBe(true);
  });

  it('lists an installed add-on with a running server as not stopped', async () => {
    h.available.mockReturnValue([entry]);
    h.installed.mockReturnValue(['twenty']);
    h.ps.mockResolvedValue({
      stdout: JSON.stringify({ Service: 'twenty-server', State: 'running', Health: 'healthy' }),
      stderr: '',
    });
    const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
    expect(listing).toMatchObject({ installed: true, stopped: false });
  });

  it("doesn't call an installed add-on stopped until the stack is ready", async () => {
    h.available.mockReturnValue([entry]);
    h.installed.mockReturnValue(['twenty']);
    h.phase.value = 'starting';
    const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
    expect(listing.stopped).toBe(false);
    expect(h.ps).not.toHaveBeenCalled();
  });

  it('lists a clean stack with the port in use as not leftover, and the fit over', async () => {
    h.available.mockReturnValue([entry]);
    const [listing] = (await call('addons:list')) as Array<Record<string, any>>;
    expect(listing.leftover).toBe(false);
    expect(listing.fit.port).toBe('over');
    expect(listing.fit.memory).toBe('tight');
    expect(listing.facts.usedMiB).toBe(5400);
  });

  it("lists Twenty's running containers while it isn't installed as leftover, with port and memory freed", async () => {
    h.available.mockReturnValue([entry]);
    h.ps.mockResolvedValue({
      stdout: JSON.stringify({ Service: 'twenty-server', State: 'running', Health: 'unhealthy' }),
      stderr: '',
    });
    const [listing] = (await call('addons:list')) as Array<Record<string, any>>;
    expect(h.ps.mock.calls[0]![0]).toEqual([
      '--profile',
      'crm',
      'ps',
      '--format',
      'json',
      ...TWENTY_ENTRY.services,
    ]);
    expect(listing.installed).toBe(false);
    expect(listing.leftover).toBe(true);
    expect(listing.fit.port).toBe('ok');
    expect(listing.fit.memory).toBe('ok');
    expect(listing.fit.verdict).toBe('ok');
  });

  it('says data removal is unavailable in a local stack', async () => {
    h.available.mockReturnValue([entry]);
    h.localStack.value = true;
    const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
    expect(listing.canRemoveData).toBe(false);
  });

  it.each([
    ['addons:install', 'install'],
    ['addons:undo', 'undo'],
    ['addons:restart', 'restart'],
    ['addons:turn-off', 'turnOff'],
    ['addons:start', 'start'],
  ] as const)('%s calls the installer', async (channel, method) => {
    h.available.mockReturnValue([entry]);
    expect(await call(channel, 'twenty')).toEqual({ success: true });
    expect(h.installer[method]).toHaveBeenCalledWith('twenty');
  });

  it('addons:install passes a validated access choice to the installer', async () => {
    h.available.mockReturnValue([entry]);
    expect(await call('addons:install', 'twenty', { access: 'read' })).toEqual({ success: true });
    expect(h.installer.install).toHaveBeenCalledWith('twenty', { access: 'read' });
    h.installer.install.mockClear();
    const refused = await call('addons:install', 'twenty', { access: 'admin' });
    expect(refused).toEqual({ success: false, error: 'Access must be read or write.' });
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('addons:install passes make room through only when it is true', async () => {
    h.available.mockReturnValue([entry]);
    await call('addons:install', 'twenty', { access: 'write', makeRoom: true });
    expect(h.installer.install).toHaveBeenLastCalledWith('twenty', { access: 'write', makeRoom: true });
    await call('addons:install', 'twenty', { makeRoom: true });
    expect(h.installer.install).toHaveBeenLastCalledWith('twenty', { makeRoom: true });
    await call('addons:install', 'twenty', { makeRoom: 'yes' });
    expect(h.installer.install).toHaveBeenLastCalledWith('twenty');
  });

  it('addons:install passes a validated remote budget to Actual’s install, and only to Actual', async () => {
    h.available.mockReturnValue([entry, ACTUAL_ENTRY]);
    const remote = {
      server: 'https://budget.example.com',
      sessionToken: 'tok',
      slug: 'home',
      syncId: 'home-1',
      access: 'write',
      replace: false,
    };
    expect(await call('addons:install', 'actual', { remote })).toEqual({ success: true });
    expect(h.installer.install).toHaveBeenCalledWith('actual', { remote });
    h.installer.install.mockClear();
    expect(await call('addons:install', 'actual', { remote: { ...remote, slug: 'Home Budget' } })).toEqual({
      success: false,
      error: 'Use lowercase letters, numbers and dashes for the name.',
    });
    expect(await call('addons:install', 'twenty', { remote })).toEqual({
      success: false,
      error: 'Only Actual connects a budget as it installs.',
    });
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('install email passes the account slug to the email installer', async () => {
    h.available.mockReturnValue([entry, EMAIL_ENTRY]);
    expect(await call('addons:install', 'email', { email: { account: 'work' } })).toEqual({ success: true });
    expect(h.installer.install).toHaveBeenCalledWith('email', { email: { account: 'work' } });
    h.installer.install.mockClear();
    expect(await call('addons:install', 'email', { email: { account: 'Work Mail' } })).toEqual({
      success: false,
      error: 'Use lowercase letters, numbers and dashes for the name.',
    });
    expect(h.installer.install).not.toHaveBeenCalled();
  });

  it('email-save-account rejects input that emailAccountInput refuses before any script runs', async () => {
    const bad = { slug: 'work', host: '', port: 993, security: 'tls', user: 'a', address: 'a@example.com', password: 'x' };
    expect(await call('addons:email-save-account', bad)).toEqual({
      success: false,
      error: 'Enter the mail server’s address.',
    });
    expect(h.email.saveAccount).not.toHaveBeenCalled();
    const good = { ...bad, host: 'imap.example.com' };
    expect(await call('addons:email-save-account', good)).toEqual({ success: true, result: { ok: true } });
    expect(h.email.saveAccount).toHaveBeenCalledWith(good);
  });

  it('email-set-mailboxes rejects an empty list', async () => {
    expect(await call('addons:email-set-mailboxes', 'work', [])).toEqual({
      success: false,
      error: 'Pick at least one mailbox.',
    });
    expect(await call('addons:email-set-mailboxes', 'work', ['Inbox', ''])).toMatchObject({ success: false });
    expect(await call('addons:email-set-mailboxes', 'Bad Slug', ['Inbox'])).toMatchObject({ success: false });
    expect(h.email.setMailboxes).not.toHaveBeenCalled();
    expect(await call('addons:email-set-mailboxes', 'work', ['Inbox'])).toEqual({ success: true, result: { ok: true } });
    expect(h.email.setMailboxes).toHaveBeenCalledWith('work', ['Inbox']);
  });

  it('cancels a new account by slug, removes one, and refuses a bad slug', async () => {
    expect(await call('addons:email-cancel-account', 'work')).toEqual({ success: true });
    expect(h.email.removeNewAccount).toHaveBeenCalledWith('work');
    expect(await call('addons:email-remove-account', 'work')).toEqual({ success: true, result: { ok: true } });
    expect(await call('addons:email-cancel-account', 'X y')).toMatchObject({ success: false });
    expect(await call('addons:email-mailboxes', 'X y')).toMatchObject({ success: false });
  });

  it('validates email settings and broadcasts email changes', async () => {
    expect(await call('addons:email-settings', { since: 'soon', attachments: false, drafts: false })).toEqual({
      success: false,
      error: 'Enter the start date as YYYY-MM-DD.',
    });
    expect(h.email.setSettings).not.toHaveBeenCalled();
    const input = { since: '2026-01-01', attachments: false, drafts: true };
    expect(await call('addons:email-settings', input)).toEqual({ success: true, result: { ok: true } });
    onEmailChange({ accounts: [] });
    expect(h.broadcast).toHaveBeenCalledWith('addons:email-changed', { accounts: [] });
  });

  it.each(['addons:install', 'addons:undo', 'addons:restart', 'addons:turn-off', 'addons:start', 'addons:remove'])(
    '%s refuses an id the stack has no add-on for',
    async (channel) => {
      h.available.mockReturnValue([entry]);
      expect(await call(channel, 'calendar-pro')).toEqual({
        success: false,
        error: 'This stack has no add-on called calendar-pro.',
      });
      h.available.mockReturnValue([]);
      expect(await call(channel, 'twenty')).toEqual({
        success: false,
        error: 'This stack has no add-on called twenty.',
      });
      for (const fn of Object.values(h.installer)) {
        if (fn !== h.installer.onChange && fn !== h.installer.snapshot) expect(fn).not.toHaveBeenCalled();
      }
    }
  );

  it('returns a failure as { success: false, error }', async () => {
    h.available.mockReturnValue([entry]);
    h.installer.turnOff.mockRejectedValueOnce(new Error('compose failed'));
    expect(await call('addons:turn-off', 'twenty')).toEqual({
      success: false,
      error: 'compose failed',
    });
  });

  it('passes remove its options, and returns the failure', async () => {
    h.available.mockReturnValue([entry]);
    expect(await call('addons:remove', 'twenty', { deleteImages: true })).toEqual({ success: true });
    expect(h.installer.remove).toHaveBeenCalledWith('twenty', { deleteImages: true });
    h.installer.remove.mockRejectedValueOnce(new Error('local stack'));
    expect(await call('addons:remove', 'twenty', { deleteImages: false })).toEqual({
      success: false,
      error: 'local stack',
    });
  });

  it('refuses remove without a deleteImages choice', async () => {
    h.available.mockReturnValue([entry]);
    expect(await call('addons:remove', 'twenty')).toEqual({
      success: false,
      error: 'Say whether to delete the images.',
    });
    expect(await call('addons:remove', 'twenty', { deleteImages: 'yes' })).toEqual({
      success: false,
      error: 'Say whether to delete the images.',
    });
    expect(h.installer.remove).not.toHaveBeenCalled();
  });

  it('returns the running work', async () => {
    expect(await call('addons:running-work')).toEqual([{ id: 'turn:1' }]);
  });

  it('returns the installer snapshot, or null when nothing has run', async () => {
    expect(await call('addons:snapshot')).toBeNull();
    const snapshot: AddonInstallSnapshot = { id: 'twenty', kind: 'install', steps: [], done: false };
    h.installer.snapshot.mockReturnValueOnce(snapshot as never);
    expect(await call('addons:snapshot')).toEqual(snapshot);
  });

  it('broadcasts each installer snapshot as addons:progress', () => {
    const snapshot: AddonInstallSnapshot = { id: 'twenty', kind: 'install', steps: [], done: false };
    onChange(snapshot);
    expect(h.broadcast).toHaveBeenCalledWith('addons:progress', snapshot);
  });

  it('returns the pending changes', async () => {
    expect(await call('addons:pending')).toEqual(['Connect work']);
  });

  it('applies pending changes by reloading Hermes, or returns the failure', async () => {
    expect(await call('addons:apply-pending')).toEqual({ success: true });
    expect(h.exclusive).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.reload).toHaveBeenCalled();
    h.apply.mockRejectedValueOnce(new Error('bootstrap exited 1'));
    expect(await call('addons:apply-pending')).toEqual({ success: false, error: 'bootstrap exited 1' });
  });

  it('applies pending changes only while no other add-on work runs', async () => {
    h.exclusive.mockRejectedValueOnce(new Error('An add-on install is already running.'));
    expect(await call('addons:apply-pending')).toEqual({
      success: false,
      error: 'An add-on install is already running.',
    });
    expect(h.apply).not.toHaveBeenCalled();
  });

  it('lists the Twenty workspaces', async () => {
    expect(await call('addons:twenty-workspaces')).toEqual([{ slug: 'work' }]);
  });

  it('connects a hosted workspace and returns the result', async () => {
    const input = { slug: 'work', url: 'https://crm.example.com', keyRw: 'a', keyRo: '', access: 'write', replace: false };
    expect(await call('addons:twenty-connect', input)).toEqual({ success: true, result: { ok: true, checks: [] } });
    expect(h.twenty.connect).toHaveBeenCalledWith(input);
  });

  it.each([
    ['a bad slug', { slug: 'Work!', url: 'https://x', keyRw: 'a', keyRo: '', access: 'write', replace: false }],
    ['a slug the store refuses', { slug: '2024-crm', url: 'https://x', keyRw: 'a', keyRo: '', access: 'write', replace: false }],
    ['a bad access', { slug: 'work', url: 'https://x', keyRw: 'a', keyRo: '', access: 'admin', replace: false }],
    ['a missing key field', { slug: 'work', url: 'https://x', keyRw: 'a', access: 'write', replace: false }],
    ['no input', undefined],
  ])('refuses a connect with %s', async (_name, input) => {
    expect(await call('addons:twenty-connect', input)).toEqual({
      success: false,
      error: 'The workspace details are incomplete.',
    });
    expect(h.twenty.connect).not.toHaveBeenCalled();
  });

  it('refuses to connect a workspace called main, which is this Mac’s', async () => {
    const input = { slug: 'main', url: 'https://x', keyRw: 'a', keyRo: '', access: 'write', replace: true };
    expect(await call('addons:twenty-connect', input)).toEqual({
      success: false,
      error: 'crm-main is this Mac’s Twenty. Pick another name.',
    });
    expect(h.twenty.connect).not.toHaveBeenCalled();
  });

  it('disconnects a workspace and sets its access', async () => {
    expect(await call('addons:twenty-disconnect', 'work')).toEqual({ success: true });
    expect(h.twenty.disconnect).toHaveBeenCalledWith('work');
    expect(await call('addons:twenty-access', 'work', 'read')).toEqual({ success: true });
    expect(h.twenty.setAccess).toHaveBeenCalledWith('work', 'read');
  });

  it('refuses a bad slug or access before the service sees it', async () => {
    expect(await call('addons:twenty-disconnect', '../x')).toEqual({
      success: false,
      error: 'crm-../x is not a workspace name.',
    });
    expect(await call('addons:twenty-access', 'work', 'admin')).toEqual({
      success: false,
      error: 'Access must be read or write.',
    });
    expect(h.twenty.disconnect).not.toHaveBeenCalled();
    expect(h.twenty.setAccess).not.toHaveBeenCalled();
  });

  it('opens Twenty at the login link without returning it', async () => {
    const result = await call('addons:twenty-open');
    expect(result).toEqual({ success: true });
    expect(h.link).toHaveBeenCalledWith({ root: '/stack', port: 3456, endpoints: expect.anything(), files: expect.anything() });
    expect(h.open).toHaveBeenCalledWith('http://localhost:3000/verify?loginToken=TOK');
    expect(JSON.stringify(result)).not.toContain('TOK');
  });

  it('passes the sign-in warning on', async () => {
    h.link.mockResolvedValueOnce({ url: 'http://localhost:3000/', signedIn: false, warning: 'W' });
    expect(await call('addons:twenty-open')).toEqual({ success: true, warning: 'W' });
  });

  it('logs whether the open signed in and why not, without the link, token or password', async () => {
    h.debugLog.mockClear();
    await call('addons:twenty-open');
    h.link.mockResolvedValueOnce({ url: 'http://localhost:3000/', signedIn: false, warning: 'W', reason: 'down' } as never);
    await call('addons:twenty-open');
    h.open.mockRejectedValueOnce(new Error('Failed to open http://localhost:3000/verify?loginToken=TOK'));
    await call('addons:twenty-open');
    expect(h.debugLog.mock.calls).toEqual([
      ['addons', 'twenty open', { signedIn: true, warning: null, opened: true }],
      ['addons', 'twenty open', { signedIn: false, warning: 'down', opened: true }],
      ['addons', 'twenty open', { signedIn: true, warning: null, opened: false }],
    ]);
    const logged = JSON.stringify(h.debugLog.mock.calls);
    expect(logged).not.toContain('TOK');
    expect(logged).not.toContain('localhost');
    expect(logged).not.toContain('verify');
  });

  it('answers a failed open with a fixed message that has no link or Electron text, and logs nothing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.open.mockRejectedValueOnce(new Error('Failed to open http://localhost:3000/verify?loginToken=TOK'));
    const result = await call('addons:twenty-open');
    expect(result).toEqual({ success: false, error: 'Couldn’t open Twenty.' });
    expect(JSON.stringify(result)).not.toContain('TOK');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it('refuses to open a link that is not http or https', async () => {
    h.link.mockResolvedValueOnce({ url: 'file:///etc/passwd', signedIn: false });
    expect(await call('addons:twenty-open')).toEqual({ success: false, error: 'Couldn’t open Twenty.' });
    expect(h.open).not.toHaveBeenCalled();
  });

  it('copies the owner password, and says so when the stack has none', async () => {
    expect(await call('addons:twenty-copy-password')).toEqual({ success: true });
    expect(h.copy).toHaveBeenCalledWith(expect.objectContaining({ root: '/stack' }));
    h.copy.mockReturnValueOnce(false);
    expect(await call('addons:twenty-copy-password')).toEqual({
      success: false,
      error: 'This stack has no saved Twenty owner login.',
    });
  });

  it('gives no Todo lists account and refuses to copy when the stack has no login', async () => {
    expect(await call('addons:vikunja-account')).toBeNull();
    expect(await call('addons:vikunja-copy-password')).toEqual({
      success: false,
      error: 'This stack has no saved Todo lists login. Turn Todo lists on first.',
    });
  });

  it('broadcasts each change to the pending list as addons:pending-changed', () => {
    h.pendingCb!(['Turn off Twenty']);
    expect(h.broadcast).toHaveBeenCalledWith('addons:pending-changed', ['Turn off Twenty']);
  });
});
