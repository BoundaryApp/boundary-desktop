import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Callout } from '../components/ui/alert';
import { Pill } from '../components/ui/badge';
import { useSetup } from '../setup/SetupContext';
import { assistantStackIPC } from '../services/assistantStackIPCService';
import type { AssistantUiServiceCard } from '../../shared/types/assistantStack';

export const AssistantServicesScreen: React.FC = () => {
  const { assistantStackStatus, refreshAssistantStack } = useSetup();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    void refreshAssistantStack();
  }, [refreshAssistantStack]);

  const services: AssistantUiServiceCard[] =
    assistantStackStatus?.uiServices ?? [];
  const ready = Boolean(assistantStackStatus?.ready);
  const offset = assistantStackStatus?.isolationMode === 'offset-ports';

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const result = await assistantStackIPC.ensureRunning();
      if (!result.success) {
        setStartError(result.error ?? 'Failed to start the assistant stack.');
      }
      await refreshAssistantStack();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [refreshAssistantStack]);

  const handleOpen = useCallback(async (service: AssistantUiServiceCard) => {
    setOpenError(null);
    try {
      const result = await window.electronAPI.urls.openUrl(service.url);
      if (!result?.success) {
        setOpenError(`Could not open ${service.title}.`);
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <div className="h-full overflow-y-auto px-10 pt-7 pb-10">
      <div className="flex max-w-[960px] flex-col gap-5">
        <header>
          <h1 className="text-heading font-medium text-fg">Services</h1>
          <p className="mt-1.5 text-xs text-fg-faint">
            Open each assistant service in your browser. They run in Boundary’s managed Compose
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
                <code className="font-mono text-xs text-fg-faint">
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
              <Button type="button" onClick={() => void handleStart()} disabled={starting}>
                {starting ? 'Starting…' : 'Start assistant'}
              </Button>
            </>
          )}
        </div>

        {(startError || openError) && (
          <Callout variant="destructive">{startError ?? openError}</Callout>
        )}

        {starting && (
          <div className="flex items-center gap-2 text-ui text-fg-faint" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Bringing up assistant services…
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <button
              key={service.id}
              type="button"
              onClick={() => void handleOpen(service)}
              className="group flex cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-line bg-surface-1 p-4 text-left outline-none transition-colors duration-(--dur-fast) hover:border-fg-faint/60 hover:bg-surface-hover focus-visible:shadow-(--focus-ring)"
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-medium text-fg">{service.title}</span>
                <ExternalLink
                  className="size-4 shrink-0 text-fg-faint transition-colors duration-(--dur-fast) group-hover:text-brand"
                  aria-hidden
                />
              </div>
              <p className="text-xs leading-relaxed text-fg-faint">{service.description}</p>
              <code className="mt-auto pt-2 font-mono text-2xs text-fg-faint">{service.url}</code>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
