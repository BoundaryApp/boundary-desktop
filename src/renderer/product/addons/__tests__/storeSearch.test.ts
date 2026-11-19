import { describe, expect, it } from 'vitest';
import { addonStoreItem } from '../storeItems';
import { applyStoreFilters, matchScore, NO_FILTERS, searchBuiltIns, searchStore } from '../storeSearch';
import { lightragListing, listing, localWorkspace, n8nListing } from './addonFixtures';

const twenty = addonStoreItem(listing(), null, []);
const n8n = addonStoreItem(n8nListing(), null, []);
const rag = addonStoreItem(lightragListing(true), null, []);
const all = [twenty, n8n, rag];

describe('searchStore', () => {
  it('ranks a name match over a keyword match over a description match', () => {
    expect(matchScore(twenty, 'twen')).toBe(4);
    expect(matchScore(twenty, 'crm')).toBe(3);
    expect(matchScore(twenty, 'contacts')).toBe(2);
    expect(matchScore(twenty, 'keep current')).toBe(1);
    expect(matchScore(twenty, 'keep it current')).toBe(0);
  });

  it('finds what people want, not only names', () => {
    expect(searchStore(all, 'contact')).toEqual([twenty]);
    expect(searchStore(all, 'Zapier')).toEqual([n8n]);
    expect(searchStore(all, 'my PDF files')).toEqual([rag]);
    expect(searchStore(all, 'track my sales pipeline')).toEqual([twenty]);
  });

  it('matches nothing for an empty query or a miss', () => {
    expect(searchStore(all, '  ')).toEqual([]);
    expect(searchStore(all, 'photos')).toEqual([]);
  });

  it('keeps catalog order for equal scores', () => {
    // n8n gives agents no tools, so its summary doesn't mention them.
    expect(searchStore(all, 'agents')).toEqual([twenty, rag]);
    expect(searchStore(all, 'workflows')).toEqual([n8n]);
  });
});

describe('searchBuiltIns', () => {
  it('finds what Boundary already runs, by name or keyword', () => {
    expect(searchBuiltIns('web search').map((b) => b.name)).toEqual(['Web search']);
    expect(searchBuiltIns('google').map((b) => b.name)).toEqual(['Web search']);
    expect(searchBuiltIns('meetings').map((b) => b.go)).toEqual([{ kind: 'settings', tab: 'calendars' }]);
    expect(searchBuiltIns('crm')).toEqual([]);
  });
});

describe('applyStoreFilters', () => {
  it('drops what won’t fit, what leaves this Mac, and what’s installed', () => {
    const big = addonStoreItem(listing({ usedMiB: 11800 }), null, []);
    expect(applyStoreFilters([big, n8n, rag], { ...NO_FILTERS, fits: true })).toEqual([n8n, rag]);
    expect(applyStoreFilters(all, { ...NO_FILTERS, local: true })).toEqual([twenty, rag]);
    const on = addonStoreItem(listing({}, true), null, [localWorkspace()]);
    expect(applyStoreFilters([on, n8n, rag], { ...NO_FILTERS, hideInstalled: true })).toEqual([n8n]);
    expect(applyStoreFilters(all, NO_FILTERS)).toEqual(all);
  });
});
