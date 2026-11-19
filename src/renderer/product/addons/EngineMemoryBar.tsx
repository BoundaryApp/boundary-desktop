import React from 'react';
import { cn } from '../../lib/utils';
import type { AddonHostFacts } from '../../../shared/addonFit';
import { memGB } from './addonCopy';

/** The container engine's memory, with an add-on's reservation drawn after what's in use. */
export const EngineMemoryBar: React.FC<{
  facts: AddonHostFacts;
  adding?: { name: string; reserveMiB: number; level: 'ok' | 'tight' | 'over' };
  /** The store sidebar's version: no legend. */
  compact?: boolean;
  className?: string;
}> = ({ facts, adding, compact, className }) => {
  const { engineMiB, usedMiB } = facts;
  const usedPct = Math.min(100, (usedMiB / engineMiB) * 100);
  const addPct = adding ? Math.min((adding.reserveMiB / engineMiB) * 100, 100 - usedPct) : 0;
  const addColor =
    adding?.level === 'over' ? 'bg-danger' : adding?.level === 'tight' ? 'bg-warn' : 'bg-brand';
  const inUse = `${memGB(usedMiB)} of ${memGB(engineMiB)} GB in use`;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-fg">Container engine memory</span>
        <span className="tabular-nums text-fg-muted">
          {`${inUse} · ${memGB(Math.max(0, engineMiB - usedMiB))} GB free`}
        </span>
      </div>
      <div role="img" aria-label={inUse} className="flex h-2 overflow-hidden rounded-full bg-surface-hover">
        <i className="block h-full bg-fg-faint" style={{ width: `${usedPct}%` }} />
        {adding ? <i className={cn('block h-full', addColor)} style={{ width: `${addPct}%` }} /> : null}
      </div>
      {compact ? null : (
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-faint">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2 rounded-full bg-fg-faint" />
          Assistant, coding agent and add-ons that are on
        </span>
        {adding ? (
          <span className="inline-flex items-center gap-1.5">
            <i aria-hidden className={cn('size-2 rounded-full', addColor)} />
            {`${adding.name} reserves ${memGB(adding.reserveMiB)} GB`}
          </span>
        ) : null}
      </div>
      )}
    </div>
  );
};
