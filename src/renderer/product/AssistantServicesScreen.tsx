import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ExternalLink } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Pill } from '../components/ui/badge';
import { refreshAssistantStackStatus, useAssistantStackStatus } from './assistantStack';
import type { AssistantUiServiceCard } from '../../shared/types/assistantStack';
import { openSettings } from './settingsNavigation';
import { useCalendarAccounts } from './useCalendarAccounts';
import { APP_NAME } from '../../shared/buildIdentity';

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

export const AssistantServicesScreen: React.FC = () => {
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
          <CalendarServiceCard />
        </div>
      </div>
    </div>
  );
};
