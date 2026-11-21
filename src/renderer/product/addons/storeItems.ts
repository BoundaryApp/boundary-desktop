import type {
  ActualOverview,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  BitwardenOverview,
  EmailOverview,
  TwentyWorkspace,
} from '../../../shared/types/addons';
import { bitwardenAttention } from './useBitwarden';
import { emailAttention } from './useEmail';
import { ADDON_FACTS, engineDown, inProgress, overallPercent, waitingForRestart } from './addonCopy';

// What the add-on store shows for each entry (docs/addon-store-ux-study/spec.md), from the catalog.

export type StoreCategory = 'work' | 'money' | 'knowledge' | 'automation';

/** Category names and the hue of their icon tiles, in sidebar order. */
export const STORE_CATEGORIES: Record<StoreCategory, { name: string; hue: number }> = {
  work: { name: 'Work & CRM', hue: 250 },
  money: { name: 'Money', hue: 145 },
  knowledge: { name: 'Knowledge', hue: 205 },
  automation: { name: 'Automation', hue: 25 },
};

export type StoreKey = AddonId;

/**
 * The store's state for one entry, which sets the card's action and the tile's mark. `view`
 * states have no action of their own, so the card opens the detail page.
 */
export type StoreState =
  | { kind: 'get' }
  | { kind: 'installing'; percent: number }
  | { kind: 'removing' }
  | { kind: 'restart' }
  | { kind: 'start' }
  | { kind: 'on'; canOpen: boolean }
  | { kind: 'off-data' }
  | {
      kind: 'view';
      line: string;
      tone: 'muted' | 'warn' | 'danger' | 'ok';
      /** Set up here in some form (connected elsewhere, or a run to look at), so it's on Services. */
      ours?: boolean;
    };

export interface StoreItem {
  key: StoreKey;
  name: string;
  summary: string;
  category: StoreCategory;
  /** Engine memory it reserves, when the catalog says. */
  reserveMiB: number | null;
  /** True when nothing it stores leaves this Mac. */
  staysLocal: boolean;
  /** False only while it isn't installed and the engine lacks the memory, disk or port it needs. */
  fits: boolean;
  /** Words people search with that its name and summary don't contain. */
  keywords: string[];
  state: StoreState;
  /** Something needs the person, such as a connected budget whose sign-in stopped working. */
  attention: boolean;
  /** A first question to ask once it's on. */
  tryAsking: string | null;
}

/** Facts the catalog doesn't carry yet (spec, Needs from the stack). */
const FACTS: Record<
  StoreKey,
  { category: StoreCategory; staysLocal: boolean; tryAsking: string | null; keywords: string[] }
> = {
  twenty: {
    category: 'work',
    staysLocal: true,
    tryAsking: ADDON_FACTS.twenty.tryAsking,
    keywords: ['crm', 'contacts', 'customers', 'people', 'sales', 'deals', 'leads', 'companies', 'pipeline'],
  },
  actual: {
    category: 'money',
    staysLocal: true,
    tryAsking: ADDON_FACTS.actual.tryAsking,
    keywords: ['budget', 'budgets', 'money', 'finance', 'spending', 'transactions', 'accounts', 'expenses', 'ynab'],
  },
  bitwarden: {
    category: 'work',
    staysLocal: false,
    tryAsking: ADDON_FACTS.bitwarden.tryAsking,
    keywords: ['passwords', 'logins', 'vault', 'vaultwarden', 'password manager', 'sign in', '2fa', 'credentials'],
  },
  email: {
    category: 'work',
    staysLocal: true,
    tryAsking: ADDON_FACTS.email.tryAsking,
    keywords: ['email', 'mail', 'inbox', 'imap', 'gmail', 'icloud', 'fastmail', 'yahoo', 'proton'],
  },
  vikunja: {
    category: 'work',
    staysLocal: true,
    tryAsking: ADDON_FACTS.vikunja.tryAsking,
    keywords: ['todo', 'todos', 'to-do', 'tasks', 'vikunja', 'checklist', 'reminders', 'kanban', 'caldav'],
  },
  n8n: {
    category: 'automation',
    staysLocal: false,
    tryAsking: ADDON_FACTS.n8n.tryAsking,
    keywords: ['workflows', 'zapier', 'schedule', 'webhooks', 'cron', 'integrations'],
  },
  lightrag: {
    category: 'knowledge',
    staysLocal: true,
    tryAsking: ADDON_FACTS.lightrag.tryAsking,
    keywords: ['rag', 'documents', 'files', 'pdf', 'graph', 'neo4j', 'notes'],
  },
};

/** n8n and LightRAG: built into the stack, turned on and off by `addon.sh` like the rest. */
export function isBuiltinAddon(id: AddonId): id is 'n8n' | 'lightrag' {
  return id === 'n8n' || id === 'lightrag';
}

/** Installed here or set to run: what the Installed page lists and counts. */
export function isInstalled(state: StoreState): boolean {
  return ['installing', 'removing', 'restart', 'start', 'on', 'off-data'].includes(state.kind);
}

/**
 * On the Services screen's Add-ons row: installed or set to run, connected to an account
 * elsewhere, being turned on or off, or a run that needs a look. Not what's only for sale.
 */
export function onServicesHome(item: StoreItem): boolean {
  const s = item.state;
  return isInstalled(s) || item.attention || (s.kind === 'view' && Boolean(s.ours));
}

/** The line for an add-on used only through accounts on other servers. */
const CONNECTED = 'Connected';

/**
 * Whether the add-on has something connected here, or data from before (Twenty's workspace
 * files, Actual's index rows and its server's stored password).
 */
function connections(
  listing: AddonListing,
  workspaces: TwentyWorkspace[] | null,
  actual: ActualOverview | null,
  bitwarden: BitwardenOverview | null,
  email: EmailOverview | null
): { remote: boolean; offData: boolean } {
  // Todo lists' lists stay in the shared database while it's off, and n8n's workflows in its volume.
  if (listing.entry.id === 'vikunja' || listing.entry.id === 'n8n') return { remote: false, offData: Boolean(listing.dataLeft) };
  // LightRAG's index and graph stay too, but `remove` can't delete them, so off is plain off.
  if (listing.entry.id === 'lightrag') return { remote: false, offData: false };
  // Email's accounts and index stay here while it's off.
  if (listing.entry.id === 'email') return { remote: false, offData: Boolean(email?.accounts.length) };
  // Bitwarden's accounts live on Bitwarden's servers; their files stay here while it's off.
  if (listing.entry.id === 'bitwarden') return { remote: false, offData: Boolean(bitwarden?.accounts.length) };
  if (listing.entry.id === 'actual') {
    return { remote: Boolean(actual?.budgets.some((b) => !b.local)), offData: Boolean(actual?.localSetUp) };
  }
  return { remote: Boolean(workspaces?.some((w) => !w.local)), offData: Boolean(workspaces?.some((w) => w.local)) };
}

/** The card's state for a catalog add-on: a run under way first, then installed, then the fit. */
function addonStoreState(
  listing: AddonListing,
  install: AddonInstallSnapshot | null,
  workspaces: TwentyWorkspace[] | null,
  actual: ActualOverview | null,
  bitwarden: BitwardenOverview | null,
  email: EmailOverview | null
): StoreState {
  if (inProgress(install)) {
    if (install.error) {
      return { kind: 'view', line: install.kind === 'remove' ? 'Removal failed' : 'Install failed', tone: 'danger', ours: true };
    }
    if (install.kind === 'remove') return { kind: 'removing' };
    if (waitingForRestart(install)) return { kind: 'restart' };
    return { kind: 'installing', percent: overallPercent(install) };
  }
  if (listing.installed && listing.stopped) return { kind: 'start' };
  // n8n and LightRAG open on ports Boundary assigns, not one the catalog names.
  if (listing.installed) return { kind: 'on', canOpen: listing.entry.port !== null || isBuiltinAddon(listing.entry.id) };
  // Connected budgets on other servers run Actual's MCP containers here, so it's on; without
  // this Mac's server there's nothing to open.
  if (listing.entry.id === 'actual' && actual?.enabled && actual.budgets.some((b) => !b.local)) {
    return { kind: 'on', canOpen: false };
  }
  if (listing.leftover) return { kind: 'view', line: 'Install didn’t finish', tone: 'warn', ours: true };
  const { remote, offData } = connections(listing, workspaces, actual, bitwarden, email);
  if (remote) return { kind: 'view', line: CONNECTED, tone: 'ok', ours: true };
  if (offData) return { kind: 'off-data' };
  if (engineDown(listing)) return { kind: 'view', line: 'Stack not running', tone: 'muted' };
  if (listing.fit.verdict === 'over') return { kind: 'view', line: 'Won’t fit', tone: 'danger' };
  return { kind: 'get' };
}

export function addonStoreItem(
  listing: AddonListing,
  install: AddonInstallSnapshot | null,
  workspaces: TwentyWorkspace[] | null,
  actual: ActualOverview | null = null,
  bitwarden: BitwardenOverview | null = null,
  email: EmailOverview | null = null
): StoreItem {
  const { entry } = listing;
  return {
    key: entry.id,
    name: entry.name,
    summary: entry.summary,
    reserveMiB: entry.reserveMiB,
    // With the engine down nothing is known, so the Fits filter doesn't hide it.
    fits: listing.installed || engineDown(listing) || listing.fit.verdict !== 'over',
    state: addonStoreState(listing, install, workspaces, actual, bitwarden, email),
    attention:
      entry.id === 'actual'
        ? Boolean(actual?.budgets.some((b) => b.state !== null && b.state !== 'ok' && b.state !== 'server_off'))
        : entry.id === 'bitwarden'
          ? bitwardenAttention(bitwarden)
          : entry.id === 'email' && emailAttention(email),
    ...FACTS[entry.id],
  };
}

/**
 * Discover's shelves (spec decision 8): the first item not yet installed is featured, and
 * a category gets a shelf of its own only with two or more items; the rest share one.
 */
export function discoverShelves(items: StoreItem[]): {
  featured: StoreItem | null;
  categories: { category: StoreCategory; items: StoreItem[] }[];
  rest: StoreItem[];
} {
  const featured = items.find((i) => !isInstalled(i.state)) ?? null;
  const others = items.filter((i) => i !== featured);
  const categories = (Object.keys(STORE_CATEGORIES) as StoreCategory[])
    .map((category) => ({ category, items: others.filter((i) => i.category === category) }))
    .filter((c) => c.items.length >= 2);
  const shelved = new Set(categories.flatMap((c) => c.items));
  return { featured, categories, rest: others.filter((i) => !shelved.has(i)) };
}
