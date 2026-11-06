import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddonInstallSnapshot } from '../../../../shared/types/addons';
import { TWENTY_ENTRY } from '../addonCatalog';

const h = vi.hoisted(() => ({
  installer: {
    install: vi.fn(async () => undefined),
    undo: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    turnOff: vi.fn(async () => undefined),
    removeData: vi.fn(async () => ({ removed: ['/data/twenty'] })),
    snapshot: vi.fn(() => null),
    onChange: vi.fn((_cb: (s: unknown) => void) => () => undefined),
  },
  root: { root: '/stack' as string | null },
  localStack: { value: false },
  available: vi.fn(),
  installed: vi.fn((_root: string) => [] as string[]),
  broadcast: vi.fn(),
  ps: vi.fn(async (_args: string[], _opts: unknown) => ({ stdout: '', stderr: '' })),
  readFacts: vi.fn(),
}));

vi.mock('../addonInstaller', () => ({ getAddonInstaller: () => h.installer }));
vi.mock('../addonCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addonCatalog')>()),
  availableAddons: (...a: unknown[]) => h.available(...a),
}));
vi.mock('../addonHostFacts', () => ({ readAddonHostFacts: h.readFacts }));
vi.mock('../../assistant/AssistantStackService', () => ({
  getAssistantStackAccess: () => ({ compose: h.ps }),
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

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

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

beforeAll(async () => {
  const electron = await import('electron');
  vi.mocked(electron.ipcMain.handle).mockImplementation(((channel: string, fn: Handler) => {
    handlers.set(channel, fn);
  }) as never);
  const { registerAddonHandlers } = await import('../ipcHandlers');
  registerAddonHandlers();
  onChange = h.installer.onChange.mock.calls[0]![0];
});

beforeEach(() => {
  vi.clearAllMocks();
  h.root.root = '/stack';
  h.localStack.value = false;
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

  it('lists each available add-on with its installed flag, fit and facts', async () => {
    h.available.mockReturnValue([entry]);
    h.installed.mockReturnValue(['twenty']);
    const [listing] = (await call('addons:list')) as Array<Record<string, unknown>>;
    expect(listing.entry).toEqual(entry);
    expect(listing.installed).toBe(true);
    expect(h.installed).toHaveBeenCalledWith('/stack');
    expect(listing.fit).toBeDefined();
    expect(listing.facts).toMatchObject({ engineMiB: 8192 });
    expect(listing.canRemoveData).toBe(true);
    expect(listing.leftover).toBe(false);
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
  ] as const)('%s calls the installer', async (channel, method) => {
    h.available.mockReturnValue([entry]);
    expect(await call(channel, 'twenty')).toEqual({ success: true });
    expect(h.installer[method]).toHaveBeenCalledWith('twenty');
  });

  it.each(['addons:install', 'addons:undo', 'addons:restart', 'addons:turn-off', 'addons:remove-data'])(
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

  it('returns the removed paths from remove-data, or the failure', async () => {
    h.available.mockReturnValue([entry]);
    expect(await call('addons:remove-data', 'twenty')).toEqual({
      success: true,
      removed: ['/data/twenty'],
    });
    h.installer.removeData.mockRejectedValueOnce(new Error('still on'));
    expect(await call('addons:remove-data', 'twenty')).toEqual({ success: false, error: 'still on' });
  });

  it('returns the running work', async () => {
    expect(await call('addons:running-work')).toEqual([{ id: 'turn:1' }]);
  });

  it('returns the installer snapshot, or null when nothing has run', async () => {
    expect(await call('addons:snapshot')).toBeNull();
    const snapshot: AddonInstallSnapshot = { id: 'twenty', steps: [], done: false };
    h.installer.snapshot.mockReturnValueOnce(snapshot as never);
    expect(await call('addons:snapshot')).toEqual(snapshot);
  });

  it('broadcasts each installer snapshot as addons:progress', () => {
    const snapshot: AddonInstallSnapshot = { id: 'twenty', steps: [], done: false };
    onChange(snapshot);
    expect(h.broadcast).toHaveBeenCalledWith('addons:progress', snapshot);
  });
});
