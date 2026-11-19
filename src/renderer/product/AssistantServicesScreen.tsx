import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, CalendarDays, Code, Compass, Globe, MessageSquare, Plus, Search } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Pill } from '../components/ui/badge';
import { refreshAssistantStackStatus, useAssistantStackStatus } from './assistantStack';
import type { AssistantUiServiceCard } from '../../shared/types/assistantStack';
import type { AddonListing } from '../../shared/types/addons';
import { openSettings } from './settingsNavigation';
import { useCalendarAccounts, useMacStatus } from './useCalendarAccounts';
import { macCardState } from './calendar/MacCalendarSteps';
import type { CalendarAccountView, MacStatusResult } from '../../shared/types/calendars';
import { APP_NAME } from '../../shared/buildIdentity';
import { AddonStore, type StorePage } from './addons/AddonStore';
import { openAddon } from './addons/AddonDetail';
import { memGB } from './addons/addonCopy';
import { Ring, StoreTile } from './addons/StoreTile';
import { onServicesHome, type StoreItem } from './addons/storeItems';
import { startStoppedAddon } from './addons/useAddons';
import { openBuiltinAddon, openServiceUrl, useStoreItems } from './addons/useStoreItems';
import { ServiceTile, TileGrid, type TileMenuItem, type TileTone } from './services/ServiceTile';

// The Services screen as a home screen (store spec decision 13): the services that ship with
// Boundary in one row, everything installed from the store in the next, and the store itself a
// tile and a button away.

const BUILT_IN_ICONS: Record<string, React.FC<{ className?: string }>> = {
  'hermes-webui': MessageSquare,
  searxng: Search,
  'gpt-researcher': BookOpen,
  opencode: Code,
};

/** A built-in service's face: one look for all of them, apart from the add-ons' category tints. */
const BuiltInFace: React.FC<{ icon: React.FC<{ className?: string }> }> = ({ icon: Icon }) => (
  <span aria-hidden className="grid size-24 place-items-center rounded-[24px] bg-brand-dim text-brand">
    <Icon className="size-10" />
  </span>
);

const Section: React.FC<{ id: string; title: string; lead: string; aside?: React.ReactNode; children: React.ReactNode }> = ({
  id,
  title,
  lead,
  aside,
  children,
}) => (
  <section aria-labelledby={id} className="flex flex-col gap-3">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 id={id} className="font-medium text-fg">
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-fg-faint">{lead}</p>
      </div>
      {aside}
    </header>
    {children}
  </section>
);

// ---------- Calendar ----------

/** The helper's state for the Services line: it answered, or it stopped or is missing. */
function helperLine(access: MacStatusResult['access']): string {
  if (access === 'stopped') return 'Calendar helper stopped';
  if (access === 'missing') return 'Calendar helper missing';
  return 'Calendar helper running';
}

/** The Mac account's line and helper status, checked on mount and on window focus. */
function useMacServiceLine(mac: CalendarAccountView | undefined) {
  const { status } = useMacStatus(Boolean(mac));
  if (!mac) return null;
  const allowed = mac.allowedCalendarIds ?? [];
  const titles =
    status?.access === 'granted' ? status.calendars.filter((c) => allowed.includes(c.id)).map((c) => c.title) : null;
  const count = allowed.length === 1 ? '1 calendar' : `${allowed.length} calendars`;
  return {
    line: `${mac.name} · ${titles?.length ? titles.join(', ') : count}`,
    helper: status ? helperLine(status.access) : null,
    state: macCardState(status),
  };
}

/**
 * caldav-mcp as "Calendar" (calendar spec, Phase 3): it runs only while a calendar is connected,
 * so its status is the accounts' last sign-in checks. The Mac's calendars (Phase 7) and the
 * calendar helper's live status are in its menu. Setup stays in Settings → Calendars.
 */
const CalendarTile: React.FC = () => {
  const accounts = useCalendarAccounts();
  const mac = useMacServiceLine(accounts?.find((a) => a.provider === 'mac'));

  if (!accounts) return null;
  const connected = accounts.length > 0;
  const caldav = accounts.filter((a) => a.provider !== 'mac');
  // The Mac account's live state stands in for its last test once the helper has answered.
  const checked = mac?.state ? caldav : accounts;
  const rejected = checked.some((a) => a.lastCheck?.status === 'rejected');
  const unreachable = checked.some((a) => a.lastCheck?.status === 'unreachable');
  const status: { text: string; tone: TileTone } = !connected
    ? { text: 'Off', tone: 'faint' }
    : mac?.state?.tone === 'is-bad'
      ? { text: mac.state.pill, tone: 'danger' }
      : rejected
        ? { text: 'Sign-in failed', tone: 'danger' }
        : unreachable
          ? { text: 'Unreachable', tone: 'warn' }
          : { text: 'Connected', tone: 'ok' };
  const notes = !connected
    ? ['Starts when you connect a calendar']
    : [
        ...(caldav.length ? [`CalDAV bridge · ${caldav.map((a) => a.name).join(', ')}`] : []),
        ...(mac ? [mac.line, ...(mac.helper ? [mac.helper] : [])] : []),
      ];
  const manage = () => openSettings({ tab: 'calendars' });

  return (
    <ServiceTile
      name="Calendar"
      face={<BuiltInFace icon={CalendarDays} />}
      status={status}
      hint="Your agents’ calendars, through CalDAV and this Mac’s calendars."
      dim={!connected}
      onClick={manage}
      notes={notes}
      menu={[{ label: connected ? 'Manage calendars' : 'Connect calendar', onSelect: manage }]}
    />
  );
};

// ---------- Add-ons ----------

/** The tile's status line for an add-on, from its store state. */
function addonStatus(item: StoreItem): { text: React.ReactNode; tone: TileTone } {
  const s = item.state;
  if (item.attention) return { text: 'Needs sign-in', tone: 'warn' };
  switch (s.kind) {
    case 'on':
      return { text: s.canOpen ? 'Running' : 'On', tone: 'faint' };
    case 'restart':
      return { text: 'Waiting for restart', tone: 'brand' };
    case 'start':
      return { text: 'Not running', tone: 'warn' };
    case 'installing':
      return {
        text: (
          <>
            <Ring percent={s.percent} className="size-3.5" />
            {`Installing ${s.percent}%`}
          </>
        ),
        tone: 'brand',
      };
    case 'removing':
      return { text: 'Removing…', tone: 'brand' };
    case 'off-data':
      return { text: 'Off · data kept', tone: 'faint' };
    case 'view':
      return { text: s.line, tone: s.tone === 'muted' ? 'faint' : s.tone };
    case 'get':
      // Not on Services: onServicesHome leaves out what's only for sale.
      return { text: '', tone: 'faint' };
  }
}

/** What a click and the menu do for one add-on tile. */
function addonActions(
  item: StoreItem,
  ctx: {
    listing: AddonListing | null;
    store(page: StorePage): void;
    show(line: string | null): void;
  }
): { click(): void; menu: TileMenuItem[] } {
  const s = item.state;
  const page: StorePage = { view: 'detail', id: item.key };
  const details: TileMenuItem = { label: 'Details', onSelect: () => ctx.store(page) };

  const id = item.key;
  const listing = ctx.listing;
  const openIt = (): void => {
    if (listing) void openAddon(listing).then(ctx.show);
  };
  const start = (): void => {
    if (listing) void startStoppedAddon(id, listing.entry.name);
  };
  // Turning a catalog add-on off or removing it asks first, on its page, which knows what
  // agents lose.
  const menu: TileMenuItem[] = [];
  if (s.kind === 'on' && s.canOpen) menu.push({ label: 'Open', onSelect: openIt });
  // LightRAG's graph store has a browser of its own.
  if (s.kind === 'on' && id === 'lightrag') {
    menu.push({ label: 'Open Neo4j', onSelect: () => void openBuiltinAddon('lightrag', 'Neo4j', 1).then(ctx.show) });
  }
  menu.push(details);
  const click =
    s.kind === 'on' && s.canOpen && !item.attention
      ? openIt
      : s.kind === 'start'
        ? start
        : s.kind === 'installing' || s.kind === 'removing' || s.kind === 'restart'
          ? () => ctx.store({ view: 'install', id })
          : details.onSelect;
  return { click, menu };
}

/** The installed add-ons as tiles, ending with the way into the store. */
const AddonsRow: React.FC<{ store(page: StorePage): void; show(line: string | null): void }> = ({ store, show }) => {
  const { items, listings } = useStoreItems();
  if (!items.length) return null;
  const home = items.filter(onServicesHome);
  const more = items.length - home.length;
  const running = home.filter((i) => ['on', 'restart', 'installing'].includes(i.state.kind));
  const reserved = running.reduce((n, i) => n + (i.reserveMiB ?? 0), 0);
  const listingOf = (key: string) => listings.find((l) => l.entry.id === key) ?? null;

  return (
    <>
      <div className="h-px bg-line" />
      <Section
        id="services-addons"
        title="Add-ons"
        lead={
          home.length
            ? 'Installed from the store. Right-click a tile, or use its ⋯ button, for more.'
            : 'Give your agents a CRM, a budget or a knowledge graph.'
        }
        aside={
          home.length ? (
            <span className="flex items-center gap-3 text-xs text-fg-faint">
              {reserved ? <span className="tabular-nums">{`${memGB(reserved)} GB engine memory reserved`}</span> : null}
              <button type="button" className="cursor-pointer font-medium text-brand" onClick={() => store({ view: 'installed' })}>
                See as a list
              </button>
            </span>
          ) : null
        }
      >
        <TileGrid label="Add-ons">
          {home.map((item) => {
            const actions = addonActions(item, {
              listing: listingOf(item.key),
              store,
              show,
            });
            const k = item.state.kind;
            return (
              <ServiceTile
                key={item.key}
                name={item.name}
                face={<StoreTile item={item} size="xl" />}
                status={addonStatus(item)}
                hint={item.summary}
                dim={k === 'installing' || k === 'off-data' || k === 'start'}
                onClick={actions.click}
                menu={actions.menu}
              />
            );
          })}
          <ServiceTile
            name="Get add-ons"
            face={
              <span
                aria-hidden
                className="grid size-24 place-items-center rounded-[24px] border-[1.5px] border-dashed border-line-strong text-fg-faint"
              >
                <Plus className="size-9" />
              </span>
            }
            status={{ text: more ? `${more} more in the store` : 'Browse the store', tone: 'faint' }}
            onClick={() => store({ view: 'discover' })}
            menu={[]}
          />
        </TileGrid>
      </Section>
    </>
  );
};

// ---------- Screen ----------

export const AssistantServicesScreen: React.FC = () => {
  const [store, setStore] = useState<StorePage | null>(null);
  const assistantStackStatus = useAssistantStackStatus();
  const [openError, setOpenError] = useState<string | null>(null);

  // uiServices health isn't pushed; take a fresh snapshot when the screen opens.
  useEffect(() => {
    void refreshAssistantStackStatus();
  }, []);

  const services: AssistantUiServiceCard[] = assistantStackStatus?.uiServices ?? [];
  const ready = Boolean(assistantStackStatus?.ready);
  const offset = assistantStackStatus?.isolationMode === 'offset-ports';

  // Starting moves the lifecycle to `starting`, so ProductApp swaps this screen for the start-up
  // screen, which shows progress and any failure.
  const handleStart = useCallback(() => {
    void window.electronAPI.assistantStack.ensureRunning().catch(() => {
      /* lifecycle carries failures */
    });
  }, []);

  const handleOpen = useCallback((service: AssistantUiServiceCard): void => {
    void openServiceUrl(service.url, service.title).then(setOpenError);
  }, []);

  const copyAddress = (url: string): void => {
    void navigator.clipboard?.writeText(url).catch((): void => undefined);
  };

  if (store) {
    return <AddonStore page={store} go={setStore} onServices={() => setStore(null)} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-10">
      <div className="flex max-w-[1040px] flex-col gap-7">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-heading font-medium text-fg">Services</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-ui text-fg-muted">
              {ready ? (
                <>
                  <Pill variant="ok" dot>
                    Assistant running
                  </Pill>
                  {assistantStackStatus?.apiBaseUrl && (
                    <code
                      className="min-w-0 max-w-full truncate font-mono text-xs text-fg-faint"
                      title={assistantStackStatus.apiBaseUrl}
                    >
                      {assistantStackStatus.apiBaseUrl}
                    </code>
                  )}
                  {offset && <span className="text-xs text-fg-faint">(offset ports — developer stack holds the defaults)</span>}
                </>
              ) : (
                <>
                  <Pill variant="warn" dot>
                    Not ready
                  </Pill>
                  <span>Your assistant isn’t running yet.</span>
                  <Button type="button" onClick={handleStart}>
                    Start assistant
                  </Button>
                </>
              )}
            </div>
          </div>
          <Button type="button" data-guide-anchor="addon-store" onClick={() => setStore({ view: 'discover' })}>
            <Compass className="size-4" aria-hidden />
            Add-on store
          </Button>
        </header>

        {openError && <Callout variant="destructive">{openError}</Callout>}

        <Section id="services-built-in" title="Built in" lead={`Part of ${APP_NAME}. They start and stop with your assistant.`}>
          <TileGrid label="Built in">
            {services.map((service) => (
              <ServiceTile
                key={service.id}
                name={service.title}
                face={<BuiltInFace icon={BUILT_IN_ICONS[service.id] ?? Globe} />}
                status={{ text: ready ? 'Running' : 'Stopped', tone: 'faint' }}
                hint={`${service.description} ${service.url}`}
                disabled={!ready}
                onClick={() => handleOpen(service)}
                menu={[
                  { label: 'Open in browser', onSelect: () => handleOpen(service) },
                  { label: 'Copy address', onSelect: () => copyAddress(service.url) },
                ]}
              />
            ))}
            <CalendarTile />
          </TileGrid>
        </Section>

        <AddonsRow store={setStore} show={setOpenError} />
      </div>
    </div>
  );
};
