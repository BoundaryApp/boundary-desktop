import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ExternalLink } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Pill } from '../components/ui/badge';
import { refreshAssistantStackStatus, useAssistantStackStatus } from './assistantStack';
import type {
  AssistantStackStatus,
  AssistantUiServiceCard,
} from '../../shared/types/assistantStack';
import {
  ASSISTANT_UI_SERVICES,
  buildServiceUrl,
  type AssistantUiServiceDefinition,
} from '../../shared/assistantUiServices';
import { openSettings } from './settingsNavigation';
import { useCalendarAccounts } from './useCalendarAccounts';
import { APP_NAME } from '../../shared/buildIdentity';
import type { AddonId } from '../../shared/types/addons';
import { AddonsSection } from './addons/AddonsSection';
import { AddonCrumbs, AddonDetail } from './addons/AddonDetail';
import { AddonInstallProgress } from './addons/AddonInstallProgress';
import { inProgress } from './addons/addonCopy';
import { useAddonListing, useAnyAddonInstall } from './addons/useAddons';

/**
 * caldav-mcp as "Calendar" (calendar spec, Phase 3): it runs only while a calendar is connected,
 * so its status is the accounts' last sign-in checks. Setup stays in Settings → Calendars.
 */
const CalendarServiceCard: React.FC = () => {
  const accounts = useCalendarAccounts();

  if (!accounts) return null;
  const connected = accounts.length > 0;
  const rejected = accounts.filter((a) => a.lastCheck?.status === 'rejected');
  const unreachable = accounts.filter((a) => a.lastCheck?.status === 'unreachable');
  const status = !connected
    ? null
    : rejected.length
      ? { variant: 'destructive' as const, label: 'Sign-in failed' }
      : unreachable.length
        ? { variant: 'warn' as const, label: 'Unreachable' }
        : { variant: 'ok' as const, label: 'Connected' };

  return (
    <section
      aria-label="Calendar"
      className="flex flex-col items-start gap-1.5 rounded-lg border border-line bg-surface-1 p-4"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="font-medium text-fg">Calendar</span>
        {status ? (
          <Pill variant={status.variant} dot>
            {status.label}
          </Pill>
        ) : (
          <Pill variant="outline">Off</Pill>
        )}
      </div>
      <p className="text-xs leading-relaxed text-fg-faint">
        {connected
          ? `CalDAV bridge · ${accounts.map((a) => a.name).join(', ')}`
          : 'Starts when you connect a calendar'}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-auto"
        onClick={() => openSettings({ tab: 'calendars' })}
      >
        <CalendarDays className="size-4" aria-hidden />
        {connected ? 'Manage calendars' : 'Connect calendar'}
      </Button>
    </section>
  );
};

type AddonView = { view: 'list' } | { view: 'detail' | 'install'; id: AddonId };

/** An add-on's detail page or install view, in place of the service list. */
const AddonPage: React.FC<{ page: Exclude<AddonView, { view: 'list' }>; go(next: AddonView): void }> = ({
  page,
  go,
}) => {
  const listing = useAddonListing(page.id);
  const toList = () => go({ view: 'list' });
  const toDetail = () => go({ view: 'detail', id: page.id });
  if (page.view === 'detail') {
    return (
      <AddonDetail id={page.id} onBack={toList} onInstallStarted={() => go({ view: 'install', id: page.id })} />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {listing ? <AddonCrumbs name={listing.entry.name} onBack={toList} /> : null}
      <AddonInstallProgress id={page.id} onDone={toDetail} />
    </div>
  );
};

type OptionalServiceOpen = AssistantUiServiceDefinition;

/** LightRAG's card opens its WebUI and the Neo4j browser. */
const LIGHTRAG_OPENS = ASSISTANT_UI_SERVICES.filter(
  (service) => service.id === 'lightrag' || service.id === 'neo4j'
);

/**
 * A service that is off unless the user turns it on here: n8n, and LightRAG with Neo4j. Turning
 * it on or off while the assistant runs starts it, or stops and removes its containers; its data
 * volumes stay.
 */
const OptionalServiceCard: React.FC<{
  status: AssistantStackStatus;
  name: string;
  setting: { enabled: boolean; canToggle: boolean };
  /** What it does, shown while it's on. */
  summary: string;
  /** Shown instead of the switch under dev:local-stack. */
  localCaption: string;
  /** Shown under the on switch while it's off. */
  offCaption?: string;
  opens: OptionalServiceOpen[];
  setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  onOpen: (service: AssistantUiServiceCard) => void;
}> = ({ status, name, setting, summary, localCaption, offCaption, opens, setEnabled, onOpen }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { enabled, canToggle } = setting;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setEnabled(!enabled);
      if (!result.success) setError(result.error ?? `Couldn’t change ${name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await refreshAssistantStackStatus();
      setBusy(false);
    }
  };

  const caption = !canToggle
    ? localCaption
    : busy
      ? enabled
        ? `Stopping ${name}…`
        : `Starting ${name}…`
      : enabled
        ? status.ready
          ? summary
          : 'Starts with your assistant.'
        : `${summary} ${offCaption ?? 'Off until you turn it on.'}`;

  return (
    <section
      aria-label={name}
      className="flex flex-col items-start gap-1.5 rounded-lg border border-line bg-surface-1 p-4"
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="font-medium text-fg">{name}</span>
        {enabled ? (
          <Pill variant="ok" dot>
            On
          </Pill>
        ) : (
          <Pill variant="outline">Off</Pill>
        )}
      </div>
      <p className="text-xs leading-relaxed text-fg-faint">{caption}</p>
      {error && <p className="text-xs leading-relaxed text-danger">{error}</p>}
      <div className="mt-auto flex flex-wrap gap-2 pt-2">
        {canToggle && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {enabled ? 'Turn off' : 'Turn on'}
          </Button>
        )}
        {enabled &&
          status.ready &&
          opens.map((open) => (
            <Button
              key={open.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                onOpen({ ...open, url: buildServiceUrl(status.ports, open.portKey, open.path) })
              }
            >
              <ExternalLink className="size-4" aria-hidden />
              {opens.length > 1 ? `Open ${open.title}` : 'Open'}
            </Button>
          ))}
      </div>
    </section>
  );
};

export const AssistantServicesScreen: React.FC = () => {
  const [addonView, setAddonView] = useState<AddonView>({ view: 'list' });
  const addonInstall = useAnyAddonInstall();
  const assistantStackStatus = useAssistantStackStatus();
  const [openError, setOpenError] = useState<string | null>(null);

  // uiServices health isn't pushed; take a fresh snapshot when the screen opens.
  useEffect(() => {
    void refreshAssistantStackStatus();
  }, []);

  const services: AssistantUiServiceCard[] =
    assistantStackStatus?.uiServices ?? [];
  const ready = Boolean(assistantStackStatus?.ready);
  const offset = assistantStackStatus?.isolationMode === 'offset-ports';

  // Starting moves the lifecycle to `starting`, so ProductApp swaps this screen for the start-up
  // screen, which shows progress and any failure.
  const handleStart = useCallback(() => {
    void window.electronAPI.assistantStack.ensureRunning().catch(() => {
      /* lifecycle carries failures */
    });
  }, []);

  const handleOpen = useCallback(async (service: AssistantUiServiceCard) => {
    setOpenError(null);
    try {
      const result = await window.electronAPI.urls.openUrl(service.url);
      if (!result.success) {
        setOpenError(`Could not open ${service.title}.`);
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // A card opens the install view while that add-on's install is under way, else its detail page.
  const openAddon = useCallback(
    (id: AddonId) =>
      setAddonView({
        view: addonInstall?.id === id && inProgress(addonInstall) ? 'install' : 'detail',
        id,
      }),
    [addonInstall]
  );

  if (addonView.view !== 'list') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-10">
        <div className="max-w-[960px]">
          <AddonPage page={addonView} go={setAddonView} />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-7 pb-10">
      <div className="flex max-w-[960px] flex-col gap-5">
        <header>
          <h1 className="text-heading font-medium text-fg">Services</h1>
          <p className="mt-1.5 text-xs text-fg-faint">
            Open each assistant service in your browser. They run in {APP_NAME}’s managed Compose
            project on this machine.
          </p>
        </header>

        <div className="flex flex-wrap items-center gap-3 text-ui text-fg-muted">
          {ready ? (
            <>
              <Pill variant="ok" dot>
                Hermes API healthy
              </Pill>
              {assistantStackStatus?.apiBaseUrl && (
                <code
                  className="min-w-0 max-w-full truncate font-mono text-xs text-fg-faint"
                  title={assistantStackStatus.apiBaseUrl}
                >
                  {assistantStackStatus.apiBaseUrl}
                </code>
              )}
              {offset && (
                <span className="text-xs text-fg-faint">
                  (offset ports — developer stack holds the defaults)
                </span>
              )}
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

        {openError && <Callout variant="destructive">{openError}</Callout>}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <button
              key={service.id}
              type="button"
              onClick={() => void handleOpen(service)}
              className="group flex min-w-0 cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-line bg-surface-1 p-4 text-left outline-none transition-colors duration-(--dur-fast) hover:border-fg-faint/60 hover:bg-surface-hover focus-visible:shadow-(--focus-ring)"
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-medium text-fg">{service.title}</span>
                <ExternalLink
                  className="size-4 shrink-0 text-fg-faint transition-colors duration-(--dur-fast) group-hover:text-brand"
                  aria-hidden
                />
              </div>
              <p className="text-xs leading-relaxed text-fg-faint">{service.description}</p>
              <code
                className="mt-auto max-w-full truncate pt-2 font-mono text-2xs text-fg-faint"
                title={service.url}
              >
                {service.url}
              </code>
            </button>
          ))}
          {assistantStackStatus?.n8n && (
            <OptionalServiceCard
              status={assistantStackStatus}
              name="n8n"
              setting={assistantStackStatus.n8n}
              summary="Workflow automation."
              localCaption="Set by the local stack’s .env (AUTOMATION_ENABLED)."
              opens={[
                { id: 'n8n', title: 'n8n', description: 'Workflow automation.', portKey: 'n8n', path: '/' },
              ]}
              setEnabled={(enabled) => window.electronAPI.assistantStack.setN8nEnabled(enabled)}
              onOpen={(s) => void handleOpen(s)}
            />
          )}
          {assistantStackStatus?.lightrag && (
            <OptionalServiceCard
              status={assistantStackStatus}
              name="LightRAG"
              setting={assistantStackStatus.lightrag}
              summary="Knowledge graph over your documents, stored in Neo4j."
              localCaption="Set by the local stack’s .env (COMPOSE_PROFILES)."
              offCaption="Off until you turn it on. Turning it on restarts your assistant."
              opens={LIGHTRAG_OPENS}
              setEnabled={(enabled) => window.electronAPI.assistantStack.setLightragEnabled(enabled)}
              onOpen={(s) => void handleOpen(s)}
            />
          )}
          <CalendarServiceCard />
        </div>

        <AddonsSection onOpen={openAddon} />
      </div>
    </div>
  );
};
