import React, { useEffect, useRef, useState } from 'react';
import { Check, Compass, Network, Package, Search, Users, Wallet, Workflow, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Callout } from '../../components/ui/alert';
import { Pill } from '../../components/ui/badge';
import { Sheet } from '../../components/ui/sheet';
import { cn } from '../../lib/utils';
import { APP_NAME } from '../../../shared/buildIdentity';
import type { AddonId, AddonListing, TwentyAccess } from '../../../shared/types/addons';
import { openSettings } from '../settingsNavigation';
import { bytesGB, hereFacts, isTwoWay, memGB, SETUP_WAYS } from './addonCopy';
import { AccessRadios, ChangeWayLink, SetupChoice, STILL_SHEET, type SetupWay } from './addonFormParts';
import { AddonDetail, openAddon } from './AddonDetail';
import { AddonInstallProgress } from './AddonInstallProgress';
import { EmailConnectSheet } from './EmailConnectSheet';
import { TwentyConnectSheet } from './TwentyConnectSheet';
import { EngineMemoryBar } from './EngineMemoryBar';
import { PendingRestartBar } from './PendingRestartBar';
import { ACCESS_HELP } from './TwentySetupPaths';
import {
  discoverShelves,
  isBuiltinAddon,
  isInstalled,
  STORE_CATEGORIES,
  type StoreCategory,
  type StoreItem,
} from './storeItems';
import {
  startAddonInstall,
  startStoppedAddon,
  useRestartWhenIdle,
  useRunningWork,
} from './useAddons';
import { ACTUAL_ACCESS_HELP, ActualConnectSheet } from './ActualConnectSheet';
import { Ring, StoreTile } from './StoreTile';
import { useStoreItems } from './useStoreItems';
import { useActualOverview } from './useActual';
import { useTwentyWorkspaces } from './useTwenty';
import {
  applyStoreFilters,
  NO_FILTERS,
  searchBuiltIns,
  searchStore,
  type BuiltIn,
  type StoreFilters,
} from './storeSearch';

export type StorePage =
  | { view: 'discover' }
  | { view: 'installed' }
  | { view: 'category'; category: StoreCategory }
  | { view: 'detail' | 'install'; id: AddonId };

const CATEGORY_ICONS: Record<StoreCategory, React.FC<{ className?: string }>> = {
  work: Users,
  money: Wallet,
  knowledge: Network,
  automation: Workflow,
};

// ---------- Pieces ----------

interface Handlers {
  act(item: StoreItem): void;
}

const pillButton =
  'inline-flex h-7 min-w-16 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 text-xs font-semibold focus-visible:shadow-(--focus-ring) outline-none';

/** The card's one action; its label says the state (spec decision 2). */
const StoreAction: React.FC<{ item: StoreItem; handlers: Handlers }> = ({ item, handlers }) => {
  const s = item.state;
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    handlers.act(item);
  };
  if (s.kind === 'installing') {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums text-brand">
        <Ring percent={s.percent} />
        {`${s.percent}%`}
      </span>
    );
  }
  if (s.kind === 'removing') {
    return (
      <span role="status" className="text-xs font-medium text-brand">
        Removing…
      </span>
    );
  }
  if (s.kind === 'on' && !s.canOpen) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-faint">
        <Check className="size-3.5" aria-hidden />
        On
      </span>
    );
  }
  const label =
    s.kind === 'get'
      ? 'Get'
      : s.kind === 'off-data'
        ? 'Turn on'
        : s.kind === 'restart'
          ? 'Restart'
          : s.kind === 'start'
            ? 'Start'
            : s.kind === 'on'
              ? 'Open'
              : 'View';
  const look =
    s.kind === 'on' || s.kind === 'view'
      ? 'border border-line-strong bg-surface-2 text-fg hover:bg-surface-hover'
      : s.kind === 'start'
        ? 'bg-warn-dim text-warn hover:brightness-95'
        : 'bg-brand-dim text-brand hover:brightness-95';
  return (
    <button type="button" className={cn(pillButton, look)} onClick={click} aria-label={`${label} ${item.name}`}>
      {label}
    </button>
  );
};

/** The card's small line: its state, or its size before it's installed. */
function stateLine(item: StoreItem): { text: string; tone: string } {
  const s = item.state;
  if (item.attention) return { text: 'Sign in again', tone: 'text-warn' };
  switch (s.kind) {
    case 'on':
      return { text: 'Installed', tone: 'text-ok' };
    case 'restart':
      return { text: 'Waiting for restart', tone: 'text-brand' };
    case 'start':
      return { text: 'Installed · not running', tone: 'text-warn' };
    case 'installing':
      return { text: 'Installing', tone: 'text-brand' };
    case 'removing':
      return { text: 'Removing', tone: 'text-brand' };
    case 'off-data':
      return { text: 'Off · data kept', tone: 'text-fg-faint' };
    case 'view':
      return {
        text: s.line,
        tone: s.tone === 'danger' ? 'text-danger' : s.tone === 'warn' ? 'text-warn' : s.tone === 'ok' ? 'text-ok' : 'text-fg-faint',
      };
    case 'get':
      return item.reserveMiB
        ? { text: `${memGB(item.reserveMiB)} GB memory`, tone: 'text-fg-faint' }
        : { text: 'Nothing to download', tone: 'text-fg-faint' };
  }
}

const StoreCard: React.FC<{ item: StoreItem; handlers: Handlers; onOpen(item: StoreItem): void }> = ({
  item,
  handlers,
  onOpen,
}) => {
  const line = stateLine(item);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={item.name}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
      className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-1 p-3.5 text-left outline-none transition-colors duration-(--dur-fast) hover:border-line-strong focus-visible:shadow-(--focus-ring)"
    >
      <span className="row-span-2 self-start">
        <StoreTile item={item} />
      </span>
      <span className="truncate font-medium text-fg">{item.name}</span>
      <StoreAction item={item} handlers={handlers} />
      <span className="col-span-2 line-clamp-2 text-xs leading-relaxed text-fg-muted">{item.summary}</span>
      <span className="col-start-2 col-end-4 mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-faint">
        <span>{STORE_CATEGORIES[item.category].name}</span>
        <span aria-hidden>·</span>
        <span className={cn('tabular-nums', line.tone)}>{line.text}</span>
      </span>
    </div>
  );
};

const Shelf: React.FC<{ title: string; lead?: string; aside?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  lead,
  aside,
  children,
}) => (
  <section aria-label={title} className="flex flex-col gap-2.5">
    <header className="flex items-baseline justify-between gap-3">
      <div>
        <h2 className="font-medium text-fg">{title}</h2>
        {lead ? <p className="mt-0.5 text-xs text-fg-faint">{lead}</p> : null}
      </div>
      {aside}
    </header>
    {children}
  </section>
);

const CardGrid: React.FC<{ items: StoreItem[]; handlers: Handlers; onOpen(item: StoreItem): void }> = ({
  items,
  handlers,
  onOpen,
}) => (
  <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
    {items.map((item) => (
      <StoreCard key={item.key} item={item} handlers={handlers} onOpen={onOpen} />
    ))}
  </div>
);

// ---------- Get sheet ----------

/** Where the store's Get is: the choice of ways (decision 14), the install's fit, or the connect form. */
type GetStep = 'choose' | 'here' | 'connect';

/**
 * Get from the store. An add-on that can also connect to one the person runs elsewhere starts
 * with that choice (decision 14); the install step shows the fit drawn on the engine bar, the
 * access choice and the restart note (decision 3). `still` marks a step reached from another, so
 * the sheet changes in place.
 */
const GetSheet: React.FC<{
  listing: AddonListing | null;
  turnOn: boolean;
  step: 'choose' | 'here';
  still: boolean;
  onPick(way: SetupWay): void;
  onChangeWay(): void;
  onClose(): void;
  onStarted(): void;
}> = ({ listing, turnOn, step, still, onPick, onChangeWay, onClose, onStarted }) => {
  // A budget is financial data, so Actual starts at Look things up (decision 21).
  const [access, setAccess] = useState<TwentyAccess>(listing?.entry.id === 'actual' ? 'read' : 'write');
  if (!listing) return null;
  const { entry, fit, facts } = listing;
  const twoWay = !turnOn && isTwoWay(entry.id);
  const frame = twoWay ? (still ? STILL_SHEET : { className: 'wb-sheet-wide' }) : {};

  if (step === 'choose' && isTwoWay(entry.id)) {
    const ways = SETUP_WAYS[entry.id];
    return (
      <Sheet
        open
        onClose={onClose}
        titleId="store-get-title"
        title={`Get ${entry.name}`}
        {...frame}
        actions={
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        }
      >
        <p className="wb-sheet-lede">How do you want to use it?</p>
        <SetupChoice
          ways={{
            here: { body: ways.here, facts: hereFacts(entry) },
            connect: { body: ways.connect, facts: ways.connectFacts },
          }}
          onPick={onPick}
        />
      </Sheet>
    );
  }

  const help = entry.id === 'actual' ? ACTUAL_ACCESS_HELP : ACCESS_HELP;
  const left = fit.freeMiB - entry.reserveMiB;
  const download = `${bytesGB(entry.downloadBytes)} GB download`;
  const install = () => {
    if (turnOn) startAddonInstall(entry.id);
    else startAddonInstall(entry.id, access);
    onStarted();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      titleId="store-get-title"
      title={`${turnOn ? 'Turn on' : 'Install'} ${entry.name}?`}
      {...frame}
      kicker={
        twoWay ? (
          <ChangeWayLink onClick={onChangeWay} />
        ) : turnOn ? (
          'Its data from before is still on this Mac'
        ) : (
          download
        )
      }
      actions={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={install}>
            {turnOn ? 'Turn on' : 'Install'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <EngineMemoryBar facts={facts} adding={{ name: entry.name, reserveMiB: entry.reserveMiB, level: fit.memory }} />
          <p className="text-xs text-fg-muted">
            {twoWay ? `${download}. ` : ''}
            {fit.verdict === 'tight'
              ? `Fits, with ${memGB(left)} GB left. Other add-ons may not fit after this.`
              : `Fits, with ${memGB(left)} GB left.`}
          </p>
        </div>
        {turnOn ? null : (
          <AccessRadios name="store-get-access" value={access} help={help} onChange={setAccess} />
        )}
        <p className="text-xs leading-relaxed text-fg-muted">
          {entry.restartsHermes
            ? 'When it’s done, the assistant restarts so agents get its tools. You choose when. You can leave this page while it runs.'
            : 'You can leave this page while it runs.'}
        </p>
      </div>
    </Sheet>
  );
};

// ---------- Restart bar ----------

/** One restart for an install that waits on it, shown on every store page (spec decision 5). */
const StoreRestartBar: React.FC<{ items: StoreItem[]; onSteps(id: AddonId): void }> = ({ items, onSteps }) => {
  const waiting = items.filter((i) => i.state.kind === 'restart');
  const work = useRunningWork(waiting.length > 0);
  const [queued, setQueued] = useState(false);
  const first = waiting[0];
  const restart = () => {
    if (first) void window.electronAPI.addons.restart(first.key as AddonId);
  };
  useRestartWhenIdle(queued, waiting.length > 0, restart);
  if (!first) return null;
  return (
    <section
      role="status"
      aria-label="Restart the assistant to finish"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/40 bg-brand-dim px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-xs text-fg-muted">
        <b className="font-medium text-fg">{`${first.name} is ready.`}</b>
        {' Restart the assistant so agents get its tools. Each chat re-sends its history on its next turn.'}
        {work.length ? ` Running now: ${work.map((w) => w.title).join(', ')}.` : ''}
      </p>
      <Button type="button" size="sm" variant="secondary" onClick={() => onSteps(first.key as AddonId)}>
        Show steps
      </Button>
      {work.length ? (
        <>
          <Button type="button" size="sm" disabled={queued} onClick={() => setQueued(true)}>
            {queued ? 'Restarts when the task finishes' : 'Restart when the task finishes'}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={restart}>
            Restart now
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" onClick={restart}>
          Restart assistant
        </Button>
      )}
    </section>
  );
};

// ---------- Pages ----------

/** What every browse page gets from the store. */
interface PageProps {
  items: StoreItem[];
  handlers: Handlers;
  onOpen(item: StoreItem): void;
  go(p: StorePage): void;
}

const Discover: React.FC<PageProps> = ({ items, handlers, onOpen, go }) => {
  const { featured, categories, rest } = discoverShelves(items);
  return (
    <>
      <header>
        <h1 className="text-heading font-medium text-fg">Discover</h1>
        <p className="mt-1.5 max-w-[64ch] text-xs text-fg-faint">
          Each add-on runs in this Mac’s container engine and gives your agents new tools. Data stays here unless an
          add-on says otherwise.
        </p>
      </header>
      {featured ? (
        <section
          aria-label={`Featured: ${featured.name}`}
          className="flex flex-wrap items-center gap-5 rounded-xl border border-line bg-surface-1 p-6"
        >
          <StoreTile item={featured} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-2xs font-semibold tracking-wide text-brand uppercase">Featured</span>
            <h2 className="text-title font-medium text-fg">{featured.name}</h2>
            <p className="max-w-[56ch] text-xs leading-relaxed text-fg-muted">{featured.summary}</p>
            {featured.tryAsking ? (
              <p className="text-xs text-fg-faint">{`Try asking: “${featured.tryAsking}”`}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <StoreAction item={featured} handlers={handlers} />
            <Button type="button" size="sm" variant="secondary" onClick={() => onOpen(featured)}>
              Details
            </Button>
          </div>
        </section>
      ) : null}
      {categories.map(({ category, items: shelf }) => (
        <Shelf
          key={category}
          title={STORE_CATEGORIES[category].name}
          aside={
            <button type="button" className="cursor-pointer text-xs font-medium text-brand" onClick={() => go({ view: 'category', category })}>
              {`See all ${shelf.length}`}
            </button>
          }
        >
          <CardGrid items={shelf.slice(0, 3)} handlers={handlers} onOpen={onOpen} />
        </Shelf>
      ))}
      {items.length ? null : (
        <p className="py-8 text-center text-xs text-fg-muted">Nothing matches these filters. Turn one off to see more.</p>
      )}
      {rest.length ? (
        <Shelf title={categories.length ? 'More add-ons' : 'All add-ons'}>
          <CardGrid items={rest} handlers={handlers} onOpen={onOpen} />
        </Shelf>
      ) : null}
      <p className="text-2xs text-fg-faint">
        {`New add-ons appear here when ${APP_NAME} updates its stack. Search, documents and coding are part of the assistant and always run.`}
      </p>
    </>
  );
};

const STATUS_PILL: Partial<Record<StoreItem['state']['kind'], { tone: 'ok' | 'warn' | 'brand' | 'outline'; label: string }>> = {
  on: { tone: 'ok', label: 'Running' },
  start: { tone: 'warn', label: 'Not running' },
  restart: { tone: 'brand', label: 'Waiting for restart' },
  installing: { tone: 'brand', label: 'Installing' },
  removing: { tone: 'brand', label: 'Removing' },
  'off-data': { tone: 'outline', label: 'Off · data kept' },
};

const Installed: React.FC<PageProps> = ({ items, handlers, onOpen, go }) => {
  // A connected budget whose sign-in stopped working is listed even with nothing installed here.
  const list = items.filter((i) => isInstalled(i.state) || i.attention);
  const running = list.filter((i) => ['on', 'restart', 'installing'].includes(i.state.kind));
  const reserved = running.reduce((n, i) => n + (i.reserveMiB ?? 0), 0);
  return (
    <>
      <header>
        <h1 className="text-heading font-medium text-fg">Installed</h1>
        <p className="mt-1.5 text-xs text-fg-faint">
          What’s on this Mac now. Add-ons you turn off keep their data until you remove them.
        </p>
      </header>
      {list.length ? (
        <div className="rounded-lg border border-line bg-surface-1">
          <ul aria-label="Installed add-ons">
            {list.map((item) => {
              const pill = item.attention
                ? ({ tone: 'warn', label: 'Needs sign-in' } as const)
                : item.state.kind === 'view'
                  ? ({ tone: 'ok', label: item.state.line } as const)
                  : STATUS_PILL[item.state.kind];
              return (
                <li key={item.key} className="border-b border-line last:border-b-0">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={item.name}
                    onClick={() => onOpen(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onOpen(item);
                    }}
                    className="grid cursor-pointer grid-cols-[auto_1fr_auto_auto] items-center gap-4 px-4 py-3 outline-none hover:bg-surface-2 focus-visible:shadow-(--focus-ring)"
                  >
                    <StoreTile item={item} size="sm" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-fg">{item.name}</span>
                      <span className="text-2xs text-fg-faint">
                        {STORE_CATEGORIES[item.category].name}
                      </span>
                    </span>
                    {pill ? (
                      <Pill variant={pill.tone} dot={pill.tone !== 'outline'}>
                        {pill.label}
                      </Pill>
                    ) : (
                      <span />
                    )}
                    <StoreAction item={item} handlers={handlers} />
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-between gap-3 rounded-b-lg border-t border-line bg-surface-2 px-4 py-2.5 text-xs text-fg-muted">
            <span>{`${running.length} running`}</span>
            {reserved ? <span className="tabular-nums">{`${memGB(reserved)} GB of engine memory reserved`}</span> : null}
          </div>
        </div>
      ) : (
        <div className="py-12 text-center text-xs text-fg-muted">
          <h2 className="mb-1.5 text-ui font-medium text-fg">No add-ons yet</h2>
          {'Browse '}
          <button type="button" className="cursor-pointer font-medium text-brand" onClick={() => go({ view: 'discover' })}>
            Discover
          </button>
          {' to give your agents a CRM.'}
        </div>
      )}
    </>
  );
};

const CategoryPage: React.FC<{ category: StoreCategory; items: StoreItem[]; handlers: Handlers; onOpen(item: StoreItem): void }> = ({
  category,
  items,
  handlers,
  onOpen,
}) => {
  const list = items.filter((i) => i.category === category);
  return (
    <>
      <header>
        <h1 className="text-heading font-medium text-fg">{STORE_CATEGORIES[category].name}</h1>
        <p className="mt-1.5 text-xs text-fg-faint">{`${list.length} add-on${list.length === 1 ? '' : 's'}`}</p>
      </header>
      <CardGrid items={list} handlers={handlers} onOpen={onOpen} />
    </>
  );
};

// ---------- Search ----------

const FILTER_LABELS: [keyof StoreFilters, string][] = [
  ['fits', 'Fits this Mac'],
  ['local', 'Stays on this Mac'],
  ['hideInstalled', 'Hide installed'],
];

/** The search field, with "/" to focus it from anywhere in the store and Escape to clear it. */
const SearchField: React.FC<{ query: string; onChange(q: string): void }> = ({ query, onChange }) => {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <label className="relative flex min-w-0 flex-1 items-center sm:max-w-[520px]">
      <Search className="pointer-events-none absolute left-2.5 size-4 text-fg-faint" aria-hidden />
      <input
        ref={input}
        type="text"
        value={query}
        aria-label="Search add-ons"
        data-guide-anchor="addon-search"
        placeholder="Search add-ons, or what you want your agent to do"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation();
            onChange('');
          }
        }}
        className="h-9 w-full rounded-md border border-line-strong bg-surface-1 pr-9 pl-8 text-ui text-fg outline-none placeholder:text-fg-faint field-focus"
      />
      {query ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1.5 grid size-6 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute right-2 rounded border border-line bg-surface-2 px-1.5 font-mono text-2xs text-fg-faint">
          /
        </kbd>
      )}
    </label>
  );
};

const FilterChips: React.FC<{ filters: StoreFilters; onChange(f: StoreFilters): void }> = ({ filters, onChange }) => (
  <div role="group" aria-label="Filters" className="flex flex-wrap gap-1.5">
    {FILTER_LABELS.map(([key, label]) => (
      <button
        key={key}
        type="button"
        aria-pressed={filters[key]}
        onClick={() => onChange({ ...filters, [key]: !filters[key] })}
        className={cn(
          'h-7 cursor-pointer rounded-full border px-3 text-xs outline-none focus-visible:shadow-(--focus-ring)',
          filters[key]
            ? 'border-solid-bg bg-solid-bg text-solid-fg'
            : 'border-line-strong bg-surface-1 text-fg-muted hover:bg-surface-hover'
        )}
      >
        {label}
      </button>
    ))}
  </div>
);

/** Results for a query: matching add-ons, then what Boundary already runs (spec decision 6). */
const SearchResults: React.FC<{
  query: string;
  items: StoreItem[];
  filters: StoreFilters;
  handlers: Handlers;
  onOpen(item: StoreItem): void;
  onBuiltIn(b: BuiltIn): void;
}> = ({ query, items, filters, handlers, onOpen, onBuiltIn }) => {
  const all = searchStore(items, query);
  const hits = applyStoreFilters(all, filters);
  const hidden = all.length - hits.length;
  const builtIns = searchBuiltIns(query);
  const q = query.trim();
  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-title font-medium text-fg">
          {`${hits.length} add-on${hits.length === 1 ? '' : 's'} for “${q}”`}
        </h1>
        {hidden ? <span className="text-xs text-fg-faint">{`${hidden} more hidden by filters`}</span> : null}
      </header>
      {hits.length ? (
        <CardGrid items={hits} handlers={handlers} onOpen={onOpen} />
      ) : (
        <div className="py-8 text-center text-xs text-fg-muted">
          <h2 className="mb-1.5 text-ui font-medium text-fg">{`No add-on for “${q}” yet`}</h2>
          Search looks at names, descriptions and what you can ask. Try a word like “contacts” or “documents”.
        </div>
      )}
      {builtIns.length ? (
        <section aria-label={`Already in ${APP_NAME}`} className="rounded-lg border border-line bg-surface-1">
          <p className="border-b border-line px-4 py-2.5 text-xs text-fg-muted">
            <b className="font-medium text-fg">{`Already in ${APP_NAME}.`}</b>
            {' These run with the assistant and need no add-on.'}
          </p>
          <ul>
            {builtIns.map((b) => (
              <li key={b.name} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-ui text-fg">{b.name}</span>
                  <span className="text-2xs text-fg-faint">{b.where}</span>
                </span>
                <Button type="button" size="sm" variant="secondary" onClick={() => onBuiltIn(b)} aria-label={`Go to ${b.name}`}>
                  Go there
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
};

// ---------- Store ----------

const NavButton: React.FC<{
  current: boolean;
  icon: React.FC<{ className?: string }>;
  label: string;
  count?: number;
  live?: boolean;
  onClick(): void;
}> = ({ current, icon: Icon, label, count, live, onClick }) => (
  <button
    type="button"
    aria-current={current ? 'page' : undefined}
    onClick={onClick}
    className={cn(
      'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-ui text-fg-muted outline-none hover:bg-surface-hover hover:text-fg focus-visible:shadow-(--focus-ring)',
      current && 'bg-brand-dim font-medium text-fg'
    )}
  >
    <Icon className="size-4 shrink-0" aria-hidden />
    <span className="flex-1 truncate">{label}</span>
    {count !== undefined ? (
      <span className={cn('text-2xs tabular-nums', live ? 'font-semibold text-brand' : 'text-fg-faint')}>{count}</span>
    ) : null}
  </button>
);

/**
 * The add-on store (docs/addon-store-ux-study/spec.md): a sidebar of Discover, Installed and
 * categories, with the engine's memory, beside the page it picks. Twenty's detail and install
 * pages are the add-ons study's own, shown inside the store.
 */
export const AddonStore: React.FC<{ page: StorePage; go(next: StorePage): void; onServices(): void }> = ({
  page,
  go,
  onServices,
}) => {
  const [sheet, setSheet] = useState<{ id: AddonId; turnOn: boolean; step: GetStep; still: boolean } | null>(null);
  const actual = useActualOverview();
  const workspaces = useTwentyWorkspaces();
  // Email's Get installs nothing until an account has mailboxes, so it opens the connect sheet (decision 33).
  const [emailSheet, setEmailSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<StoreFilters>(NO_FILTERS);
  const { items, listings } = useStoreItems();
  const shown = applyStoreFilters(items, filters);
  const searching = query.trim() !== '';
  // Leaving for another page ends a search, so the page shows instead of the results.
  const nav = (next: StorePage) => {
    setQuery('');
    go(next);
  };
  const listingOf = (id: AddonId) => listings.find((l) => l.entry.id === id) ?? null;

  const open = (item: StoreItem) => {
    const k = item.state.kind;
    nav({ view: k === 'installing' || k === 'removing' ? 'install' : 'detail', id: item.key });
  };

  const handlers: Handlers = {
    act(item) {
      const s = item.state;
      const id = item.key;
      const listing = listingOf(id);
      // Bitwarden does nothing without an account, so Get happens on its page, beside the sheet.
      // Todo lists, n8n and LightRAG have no access choice for the Get sheet to ask, so their pages have Get too.
      if (s.kind === 'get' && (id === 'bitwarden' || id === 'vikunja' || isBuiltinAddon(id))) open(item);
      else if (s.kind === 'get' && id === 'email') setEmailSheet(true);
      else if (s.kind === 'get') setSheet({ id, turnOn: false, step: isTwoWay(id) ? 'choose' : 'here', still: false });
      // Email's Turn on is `enable` with the stored accounts, and Todo lists' and n8n's have no access to ask, so their pages run it.
      else if (s.kind === 'off-data' && (id === 'email' || id === 'vikunja' || isBuiltinAddon(id))) open(item);
      else if (s.kind === 'off-data') setSheet({ id, turnOn: true, step: 'here', still: false });
      else if (s.kind === 'restart') nav({ view: 'install', id });
      else if (s.kind === 'start' && listing) void startStoppedAddon(id, listing.entry.name);
      else if (s.kind === 'on' && listing) void openAddon(listing).then((line) => line && setError(line));
      else open(item);
    },
  };

  const installedCount = items.filter((i) => isInstalled(i.state)).length;
  const live = items.some((i) => ['installing', 'removing', 'restart', 'start'].includes(i.state.kind));
  const categories = (Object.keys(STORE_CATEGORIES) as StoreCategory[]).filter((c) => items.some((i) => i.category === c));
  const facts = listings[0]?.facts;
  // A running install or removal holds its add-on's page until it finishes or is cancelled.
  const detailRun = page.view === 'detail' ? items.find((i) => i.key === page.id)?.state.kind : undefined;
  const detailBlocked = detailRun === 'installing' || detailRun === 'removing';
  useEffect(() => {
    if (detailBlocked && page.view === 'detail') go({ view: 'install', id: page.id });
  }, [detailBlocked, page, go]);
  const browsing = page.view === 'discover' || page.view === 'installed' || page.view === 'category';

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label="Add-ons" className="flex w-56 shrink-0 flex-col border-r border-line">
        <div className="px-4 pt-6 pb-2">
          <button type="button" className="cursor-pointer text-2xs text-fg-faint hover:text-fg" onClick={onServices}>
            ← Services
          </button>
          <h2 className="mt-2 text-title font-medium text-fg">Add-ons</h2>
          <p className="mt-0.5 text-2xs text-fg-faint">Services your agents can use, run on this Mac</p>
        </div>
        <nav aria-label="Add-on pages" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
          <NavButton current={page.view === 'discover'} icon={Compass} label="Discover" onClick={() => nav({ view: 'discover' })} />
          <NavButton
            current={page.view === 'installed'}
            icon={Package}
            label="Installed"
            count={installedCount}
            live={live}
            onClick={() => nav({ view: 'installed' })}
          />
          <span className="px-2 pt-4 pb-1.5 text-2xs font-semibold tracking-wide text-fg-faint uppercase">Categories</span>
          {categories.map((c) => (
            <NavButton
              key={c}
              current={page.view === 'category' && page.category === c}
              icon={CATEGORY_ICONS[c]}
              label={STORE_CATEGORIES[c].name}
              count={items.filter((i) => i.category === c).length}
              onClick={() => nav({ view: 'category', category: c })}
            />
          ))}
        </nav>
        {facts && facts.engineMiB > 0 ? (
          <div className="m-2 rounded-lg border border-line bg-surface-1 p-3">
            <EngineMemoryBar facts={facts} compact />
          </div>
        ) : null}
      </aside>
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-10">
        <div className="flex max-w-[960px] flex-col gap-6">
          {browsing || searching ? (
            <div className="flex flex-col gap-3">
              <SearchField query={query} onChange={setQuery} />
              {page.view !== 'installed' || searching ? <FilterChips filters={filters} onChange={setFilters} /> : null}
            </div>
          ) : null}
          {browsing ? <PendingRestartBar /> : null}
          {page.view !== 'install' ? (
            <StoreRestartBar items={items} onSteps={(id) => nav({ view: 'install', id })} />
          ) : null}
          {error ? <Callout variant="destructive">{error}</Callout> : null}
          {searching ? (
            <SearchResults
              query={query}
              items={items}
              filters={filters}
              handlers={handlers}
              onOpen={open}
              onBuiltIn={(b) => (b.go.kind === 'services' ? onServices() : openSettings({ tab: b.go.tab }))}
            />
          ) : null}
          {searching ? null : page.view === 'discover' ? (
            <Discover items={shown} handlers={handlers} onOpen={open} go={nav} />
          ) : page.view === 'installed' ? (
            <Installed items={items} handlers={handlers} onOpen={open} go={nav} />
          ) : page.view === 'category' ? (
            <CategoryPage category={page.category} items={shown} handlers={handlers} onOpen={open} />
          ) : null}
          {searching || detailBlocked ? null : page.view === 'detail' ? (
            <AddonDetail
              id={page.id}
              onBack={() => nav({ view: 'discover' })}
              onServices={onServices}
              onInstallStarted={() => nav({ view: 'install', id: page.id })}
            />
          ) : null}
          {!searching && page.view === 'install' ? (
            <AddonInstallProgress id={page.id} onDone={() => nav({ view: 'detail', id: page.id })} />
          ) : null}
        </div>
      </div>
      {sheet && sheet.step !== 'connect' ? (
        <GetSheet
          listing={listingOf(sheet.id)}
          turnOn={sheet.turnOn}
          step={sheet.step}
          still={sheet.still}
          onPick={(way) => setSheet({ ...sheet, step: way === 'here' ? 'here' : 'connect', still: true })}
          onChangeWay={() => setSheet({ ...sheet, step: 'choose', still: true })}
          onClose={() => setSheet(null)}
          onStarted={() => {
            setSheet(null);
            nav({ view: 'install', id: sheet.id });
          }}
        />
      ) : null}
      <ActualConnectSheet
        preset={sheet?.step === 'connect' && sheet.id === 'actual' ? { server: '' } : null}
        existing={(actual?.budgets ?? []).map((b) => b.slug)}
        addonOn={Boolean(actual?.enabled)}
        onClose={() => setSheet(null)}
        onInstallStarted={() => nav({ view: 'install', id: 'actual' })}
        onChangeWay={() => setSheet((s) => s && { ...s, step: 'choose', still: true })}
      />
      <TwentyConnectSheet
        open={sheet?.step === 'connect' && sheet.id === 'twenty'}
        existing={(workspaces ?? []).map((w) => w.slug)}
        onClose={() => setSheet(null)}
        onChangeWay={() => setSheet((s) => s && { ...s, step: 'choose', still: true })}
      />
      {emailSheet ? (
        <EmailConnectSheet
          mode={{ kind: 'first' }}
          onClose={() => setEmailSheet(false)}
          onStarted={() => nav({ view: 'install', id: 'email' })}
        />
      ) : null}
    </div>
  );
};
