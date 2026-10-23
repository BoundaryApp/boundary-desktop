import React, { useRef } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { AssistantStackServiceProgress } from '../../shared/types/assistantStack';

export interface ServiceProgressCardsProps {
  services: AssistantStackServiceProgress[];
  /** Visual tone for the fill bar. */
  tone?: 'start' | 'stop';
}

function isActivelyProgressing(service: AssistantStackServiceProgress, complete: boolean): boolean {
  if (complete) return false;
  if (service.state === 'working') return true;
  return /waiting|pulled|queued|download|configur|start|extract|pull|creat/i.test(
    service.statusText
  );
}

export const ServiceProgressCards: React.FC<ServiceProgressCardsProps> = ({
  services,
  tone = 'start',
}) => {
  const fillClass =
    tone === 'stop'
      ? 'bg-warn'
      : 'bg-ok';

  const highWaterRef = useRef<Record<string, number>>({});
  const toneRef = useRef(tone);
  if (toneRef.current !== tone) {
    toneRef.current = tone;
    highWaterRef.current = {};
  }

  return (
    <div className="grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {services.map((service) => {
        const highWater = Math.max(
          highWaterRef.current[service.id] ?? 0,
          service.progress
        );
        highWaterRef.current[service.id] = highWater;
        const pct = Math.round(Math.min(1, Math.max(0, highWater)) * 100);
        const complete = pct >= 100 && service.state === 'done';
        const active = isActivelyProgressing(service, complete);
        return (
          <div
            key={service.id}
            className="relative overflow-hidden rounded-md border border-line bg-surface-0 px-3 py-2.5"
            role="status"
            aria-label={`${service.title}: ${service.statusText}${complete ? '' : `, ${pct}%`}`}
          >
            <div
              className={`pointer-events-none absolute inset-y-0 left-0 ${fillClass} transition-[width] duration-500 ease-standard ${
                active ? 'animate-pulse' : ''
              }`}
              style={{ width: `${pct}%`, opacity: complete ? 0.12 : active ? 0.2 : 0.14 }}
              aria-hidden
            />
            <div className="relative flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-fg">{service.title}</span>
                {complete ? (
                  <span className="inline-flex items-center gap-1 text-xs text-ok">
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    {service.statusText === 'Stopped' ? 'Stopped' : service.statusText}
                  </span>
                ) : (
                  <span className="text-xs tabular-nums text-fg-faint">{pct}%</span>
                )}
              </div>
              {!complete && (
                <p className={`text-xs ${active ? 'text-fg-muted' : 'text-fg-faint'}`}>
                  {service.statusText}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
