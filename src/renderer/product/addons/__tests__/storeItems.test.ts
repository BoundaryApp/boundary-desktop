import { describe, expect, it } from 'vitest';
import { addonStoreItem, discoverShelves, isInstalled, onServicesHome, type StoreItem } from '../storeItems';
import { hostedWorkspace, lightragListing, listing, localWorkspace, n8nListing, snapshot } from './addonFixtures';

const state = (...args: Parameters<typeof addonStoreItem>) => addonStoreItem(...args).state;

describe('addonStoreItem', () => {
  it('offers Get when Twenty fits and nothing is set up', () => {
    expect(state(listing(), null, [])).toEqual({ kind: 'get' });
  });

  it('says it won’t fit when the engine lacks memory', () => {
    expect(state(listing({ usedMiB: 11800 }), null, [])).toEqual({ kind: 'view', line: 'Won’t fit', tone: 'danger' });
  });

  it('says the stack isn’t running when the engine reports no memory', () => {
    expect(state(listing({ engineMiB: 0, usedMiB: 0 }), null, [])).toMatchObject({ line: 'Stack not running' });
  });

  it('shows install progress, then the restart wait, then failure ahead of anything else', () => {
    expect(state(listing(), snapshot('download', 'running'), [])).toEqual({ kind: 'installing', percent: 4 });
    expect(state(listing(), snapshot('restart', 'waiting'), [])).toEqual({ kind: 'restart' });
    const failed = snapshot('setup', 'error', { error: { step: 'setup', message: 'x', logTail: [] } });
    expect(state(listing({}, true), failed, [])).toMatchObject({ line: 'Install failed', tone: 'danger' });
  });

  it('shows a removal under way', () => {
    expect(state(listing({}, true), snapshot('download', 'running', { kind: 'remove' }), [])).toEqual({ kind: 'removing' });
  });

  it('opens an installed Twenty, and offers Start when it isn’t running', () => {
    expect(state(listing({}, true), null, [localWorkspace()])).toEqual({ kind: 'on', canOpen: true });
    expect(state(listing({}, true, true, false, true), null, [localWorkspace()])).toEqual({ kind: 'start' });
  });

  it('marks leftover containers, hosted workspaces and a parked local one', () => {
    expect(state(listing({}, false, true, true), null, [])).toMatchObject({ line: 'Install didn’t finish' });
    expect(state(listing(), null, [hostedWorkspace()])).toMatchObject({ line: 'Connected', tone: 'ok' });
    expect(state(listing(), null, [localWorkspace()])).toEqual({ kind: 'off-data' });
  });

  it('carries the store facts the catalog doesn’t', () => {
    const item = addonStoreItem(listing(), null, []);
    expect(item).toMatchObject({ key: 'twenty', category: 'work', staysLocal: true, reserveMiB: 2208 });
  });

  it('fits unless it isn’t installed and the engine lacks room; an engine that’s down hides nothing', () => {
    expect(addonStoreItem(listing(), null, []).fits).toBe(true);
    expect(addonStoreItem(listing({ usedMiB: 11800 }), null, []).fits).toBe(false);
    expect(addonStoreItem(listing({ usedMiB: 11800 }, true), null, []).fits).toBe(true);
    expect(addonStoreItem(listing({ engineMiB: 0, usedMiB: 0 }), null, []).fits).toBe(true);
  });
});

describe('n8n and LightRAG', () => {
  it('offer Get like any add-on, and open once on on the ports Boundary assigns', () => {
    expect(state(n8nListing(), null, [])).toEqual({ kind: 'get' });
    expect(state(lightragListing(), null, [])).toEqual({ kind: 'get' });
    expect(state(n8nListing(true), null, [])).toEqual({ kind: 'on', canOpen: true });
    expect(state(lightragListing(true), null, [])).toEqual({ kind: 'on', canOpen: true });
  });

  it('keeps n8n’s workflows as off-data, while an off LightRAG is plain off', () => {
    expect(state(n8nListing(false, true), null, [])).toEqual({ kind: 'off-data' });
    expect(state({ ...lightragListing(), dataLeft: true }, null, [])).toEqual({ kind: 'get' });
  });
});

describe('onServicesHome', () => {
  const home = (item: StoreItem) => onServicesHome(item);

  it('has what is installed, set up elsewhere or mid-run, and leaves out what is only for sale', () => {
    expect(home(addonStoreItem(listing({}, true), null, [localWorkspace()]))).toBe(true);
    expect(home(addonStoreItem(listing({}, true, true, false, true), null, [localWorkspace()]))).toBe(true);
    expect(home(addonStoreItem(listing(), snapshot('download', 'running'), []))).toBe(true);
    expect(home(addonStoreItem(listing(), null, [hostedWorkspace()]))).toBe(true);
    expect(home(addonStoreItem(listing(), null, [localWorkspace()]))).toBe(true);
    expect(home(addonStoreItem(listing({}, false, true, true), null, []))).toBe(true);
    const failed = snapshot('setup', 'error', { error: { step: 'setup', message: 'x', logTail: [] } });
    expect(home(addonStoreItem(listing(), failed, []))).toBe(true);

    expect(home(addonStoreItem(listing(), null, []))).toBe(false);
    expect(home(addonStoreItem(listing({ usedMiB: 11800 }), null, []))).toBe(false);
    expect(home(addonStoreItem(listing({ engineMiB: 0, usedMiB: 0 }), null, []))).toBe(false);
  });

  it('has n8n or LightRAG once on, or n8n off with its workflows kept, not while only for sale', () => {
    expect(home(addonStoreItem(n8nListing(true), null, []))).toBe(true);
    expect(home(addonStoreItem(n8nListing(false, true), null, []))).toBe(true);
    expect(home(addonStoreItem(n8nListing(), null, []))).toBe(false);
    expect(home(addonStoreItem(lightragListing(true), null, []))).toBe(true);
    expect(home(addonStoreItem(lightragListing(), null, []))).toBe(false);
  });
});

describe('discoverShelves', () => {
  const item = (key: StoreItem['key'], category: StoreItem['category'], extra: Partial<StoreItem> = {}): StoreItem => ({
    key,
    name: key,
    summary: '',
    category,
    reserveMiB: null,
    staysLocal: true,
    fits: true,
    keywords: [],
    state: { kind: 'get' },
    attention: false,
    tryAsking: null,
    ...extra,
  });

  it('features the first add-on not yet installed, and gives single-item categories one shared shelf', () => {
    const twenty = item('twenty', 'work');
    const n8n = item('n8n', 'automation');
    const rag = item('lightrag', 'knowledge');
    expect(discoverShelves([twenty, n8n, rag])).toEqual({ featured: twenty, categories: [], rest: [n8n, rag] });
  });

  it('features nothing once every add-on is installed', () => {
    const twenty = item('twenty', 'work', { state: { kind: 'on', canOpen: true } });
    expect(discoverShelves([twenty]).featured).toBeNull();
    expect(isInstalled(twenty.state)).toBe(true);
  });

  it('gives a category with two items a shelf of its own', () => {
    const featured = item('twenty', 'work');
    const a = item('n8n', 'knowledge');
    const b = item('lightrag', 'knowledge');
    expect(discoverShelves([featured, a, b]).categories).toEqual([{ category: 'knowledge', items: [a, b] }]);
  });
});
