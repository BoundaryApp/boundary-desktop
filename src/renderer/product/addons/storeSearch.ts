import type { SettingsTab } from '../settingsNavigation';
import { isInstalled, STORE_CATEGORIES, type StoreItem } from './storeItems';

// Search and filters for the add-on store (docs/addon-store-ux-study/spec.md, decisions 6 and 7).

export interface StoreFilters {
  /** Leave out what won't fit in the container engine now. */
  fits: boolean;
  /** Leave out what sends data off this Mac. */
  local: boolean;
  /** Leave out what's installed or turned on. */
  hideInstalled: boolean;
}

export const NO_FILTERS: StoreFilters = { fits: false, local: false, hideInstalled: false };

export function applyStoreFilters(items: StoreItem[], f: StoreFilters): StoreItem[] {
  return items.filter(
    (i) => (!f.fits || i.fits) && (!f.local || i.staysLocal) && (!f.hideInstalled || !isInstalled(i.state))
  );
}

const norm = (text: string) => text.toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Whether a keyword answers the query: the query starts the keyword ("contact" finds
 * "contacts"), or a query of several words contains it ("my sales pipeline" finds "sales").
 */
function keywordMatches(keyword: string, q: string): boolean {
  if (keyword.startsWith(q)) return true;
  return q.includes(' ') && keyword.length >= 3 && q.split(' ').some((word) => word.startsWith(keyword));
}

/** How well an item answers the query: 0 for no match, higher first. */
export function matchScore(item: StoreItem, query: string): number {
  const q = norm(query);
  if (!q) return 0;
  const name = item.name.toLowerCase();
  if (name.startsWith(q)) return 4;
  if (name.includes(q)) return 3;
  if (item.keywords.some((k) => keywordMatches(k, q))) return 2;
  const text = [item.summary, STORE_CATEGORIES[item.category].name, item.tryAsking ?? ''].join(' ').toLowerCase();
  return text.includes(q) ? 1 : 0;
}

/** Matching items, best first; ties keep catalog order. */
export function searchStore(items: StoreItem[], query: string): StoreItem[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(item, query) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((m) => m.item);
}

/** Something Boundary always runs, which a search shouldn't make look missing. */
export interface BuiltIn {
  name: string;
  where: string;
  go: { kind: 'services' } | { kind: 'settings'; tab: SettingsTab };
  keywords: string[];
}

const BUILT_INS: BuiltIn[] = [
  {
    name: 'Web search',
    where: 'Services · SearXNG',
    go: { kind: 'services' },
    keywords: ['search', 'web', 'google', 'internet', 'browse', 'searxng'],
  },
  {
    name: 'Deep research',
    where: 'Services · GPT Researcher',
    go: { kind: 'services' },
    keywords: ['research', 'reports', 'sources'],
  },
  {
    name: 'Coding agent',
    where: 'Settings · Coding',
    go: { kind: 'settings', tab: 'coding' },
    keywords: ['code', 'coding', 'programming', 'git', 'developer', 'opencode'],
  },
  {
    name: 'Calendar',
    where: 'Settings · Calendars',
    go: { kind: 'settings', tab: 'calendars' },
    keywords: ['calendar', 'events', 'meetings', 'schedule', 'caldav'],
  },
  {
    name: 'Passwords & Logins',
    where: 'Settings · Passwords & Logins',
    go: { kind: 'settings', tab: 'passwords' },
    keywords: ['passwords', 'logins', 'credentials', 'vault', 'sign in'],
  },
];

export function searchBuiltIns(query: string): BuiltIn[] {
  const q = norm(query);
  if (!q) return [];
  return BUILT_INS.filter((b) => b.name.toLowerCase().includes(q) || b.keywords.some((k) => keywordMatches(k, q)));
}
