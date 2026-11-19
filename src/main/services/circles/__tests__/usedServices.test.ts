import { describe, expect, it, vi } from 'vitest';
import type { TwentyAccess } from '../../../../shared/types/addons';
import { createUsedServices, sharedWorkspaceSlug, type UsedService, type WorkspaceStore } from '../usedServices';

interface Stored {
  url: string;
  access: TwentyAccess;
  keys: { ro: string; rw: string };
}

function harness(options: { busy?: number[]; saved?: UsedService[]; files?: Record<string, Stored> } = {}) {
  let saved: UsedService[] = options.saved ?? [];
  const files: Record<string, Stored> = { ...options.files };
  const busy = new Set(options.busy ?? []);
  let nextPort = 41000;
  const open = new Map<number, { close: ReturnType<typeof vi.fn> }>();
  const pending: string[] = [];
  let tokens = 0;

  const store: WorkspaceStore = {
    slugFree: (slug) => !(slug in files),
    exists: (slug) => slug in files,
    write: (slug, values, keys) => {
      files[slug] = { ...values, keys };
    },
    setUrl: (slug, url) => {
      files[slug] = { ...files[slug]!, url };
    },
    remove: (slug) => {
      delete files[slug];
    },
  };

  const listen = vi.fn(async (_entry: UsedService, port: number) => {
    if (port !== 0 && busy.has(port)) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
    const bound = port || nextPort++;
    const listener = { port: bound, close: vi.fn(async () => void open.delete(bound)) };
    open.set(bound, listener);
    return listener;
  });

  const used = createUsedServices({
    load: async () => saved.map((entry) => ({ ...entry })),
    save: async (list) => {
      saved = list;
    },
    store: () => store,
    listen,
    pending: (text) => pending.push(text),
    exclusive: (work) => work(),
    log: () => undefined,
    token: () => `token-${++tokens}`,
  });
  return { used, files, open, pending, listen, saved: () => saved };
}

const input = {
  circle: 'c'.repeat(64),
  provider: 'p'.repeat(64),
  service: 'twenty.main',
  providerName: 'Ada Lovelace',
  circleName: 'Family',
  access: 'read' as const,
};

describe('sharedWorkspaceSlug', () => {
  it('joins the provider’s and Circle’s names', () => {
    expect(sharedWorkspaceSlug('Ada Lovelace', 'The Family!', () => true)).toBe('ada-lovelace-the-family');
  });

  it('starts with a letter, drops accents and stays short enough for the stack', () => {
    expect(sharedWorkspaceSlug('9 Élan', 'x'.repeat(40), () => true)).toMatch(/^s-9-elan-x+$/);
    expect(sharedWorkspaceSlug('Ada', 'x'.repeat(40), () => true).length).toBeLessThanOrEqual(26);
    expect(sharedWorkspaceSlug('😀', '', () => true)).toBe('shared');
    expect(sharedWorkspaceSlug('Crème Brûlée', 'Ñandú', () => true)).toBe('creme-brulee-nandu');
    expect(sharedWorkspaceSlug('ﬁnance', '--Ärger--', () => true)).toBe('finance-arger');
  });

  it('adds a number when the name is taken', () => {
    expect(sharedWorkspaceSlug('Ada', 'Family', (slug) => slug !== 'ada-family')).toBe('ada-family-2');
  });
});

describe('createUsedServices', () => {
  it('opens a listener, writes the workspace at its port with two tokens, and asks for a restart', async () => {
    const h = harness();
    expect(await h.used.use(input)).toEqual({ slug: 'ada-lovelace-family' });
    expect(h.files['ada-lovelace-family']).toEqual({
      url: 'http://host.docker.internal:41000',
      access: 'read',
      keys: { ro: 'token-1', rw: 'token-2' },
    });
    expect(h.saved()).toEqual([
      { circle: input.circle, provider: input.provider, service: input.service, slug: 'ada-lovelace-family', port: 41000, tokens: { read: 'token-1', write: 'token-2' } },
    ]);
    expect(h.pending).toEqual(['Connect crm-ada-lovelace-family (look things up)']);
    expect(h.open.has(41000)).toBe(true);
  });

  it('does nothing more for a service already in use', async () => {
    const h = harness();
    await h.used.use(input);
    expect(await h.used.use({ ...input, access: 'write' })).toEqual({ slug: 'ada-lovelace-family' });
    expect(h.listen).toHaveBeenCalledTimes(1);
  });

  it('removes what it wrote and closes the listener when saving fails', async () => {
    const h = harness();
    const failing = createUsedServices({
      load: async () => [],
      save: async () => {
        throw new Error('The keychain isn’t available.');
      },
      store: () => ({
        slugFree: () => true,
        exists: () => false,
        write: (slug, values, keys) => void (h.files[slug] = { ...values, keys }),
        setUrl: () => undefined,
        remove: (slug) => void delete h.files[slug],
      }),
      listen: h.listen,
      pending: () => undefined,
      exclusive: (work) => work(),
      log: () => undefined,
    });
    await expect(failing.use(input)).rejects.toThrow('keychain');
    expect(h.files).toEqual({});
    expect(h.open.size).toBe(0);
  });

  it('stops using: drops the entry and the workspace, closes the listener, asks for a restart', async () => {
    const h = harness();
    await h.used.use(input);
    await h.used.stopUsing(input.circle, input.provider, input.service);
    expect(h.saved()).toEqual([]);
    expect(h.files).toEqual({});
    expect(h.open.size).toBe(0);
    expect(h.pending).toContain('Disconnect crm-ada-lovelace-family');
  });

  const entry: UsedService = {
    circle: input.circle,
    provider: input.provider,
    service: input.service,
    slug: 'ada-family',
    port: 41500,
    tokens: { read: 'r', write: 'w' },
  };
  const file: Stored = { url: 'http://host.docker.internal:41500', access: 'read', keys: { ro: 'r', rw: 'w' } };

  it('reopens each listener on its kept port at launch, with no restart needed', async () => {
    const h = harness({ saved: [entry], files: { 'ada-family': file } });
    await h.used.startAll();
    expect(h.open.has(41500)).toBe(true);
    expect(h.pending).toEqual([]);
    expect(h.saved()).toEqual([entry]);
  });

  it('moves a listener whose kept port is taken, rewrites the workspace URL and asks for a restart', async () => {
    const h = harness({ busy: [41500], saved: [entry], files: { 'ada-family': file } });
    await h.used.startAll();
    expect(h.saved()[0]!.port).toBe(41000);
    expect(h.files['ada-family']!.url).toBe('http://host.docker.internal:41000');
    expect(h.pending).toEqual(['crm-ada-family: moved to a free port']);
  });

  it('drops a used service whose workspace was removed from the stack', async () => {
    const h = harness({ saved: [entry] });
    await h.used.startAll();
    expect(h.saved()).toEqual([]);
    expect(h.listen).not.toHaveBeenCalled();
  });

  it('lists what is used without tokens, and closes every listener at quit', async () => {
    const h = harness();
    await h.used.use(input);
    expect(await h.used.list()).toEqual([
      { circle: input.circle, provider: input.provider, service: input.service, slug: 'ada-lovelace-family' },
    ]);
    await h.used.closeAll();
    expect(h.open.size).toBe(0);
  });
});
