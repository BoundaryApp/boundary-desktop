import React from 'react';
import { Pill } from '../../components/ui/badge';
import { cn } from '../../lib/utils';
import { APP_NAME } from '../../../shared/buildIdentity';
import type { AddonHostFacts } from '../../../shared/addonFit';
import type { AddonId, AddonListing } from '../../../shared/types/addons';
import { addonPill, bytesGB, memGB } from './addonCopy';
import { useAddonListings, useAnyAddonInstall } from './useAddons';

/** The container engine's memory, with an add-on's reservation drawn after what's in use. */
export const EngineMemoryBar: React.FC<{
  facts: AddonHostFacts;
  adding?: { name: string; reserveMiB: number; level: 'ok' | 'tight' | 'over' };
  className?: string;
}> = ({ facts, adding, className }) => {
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
    </div>
  );
};

const AddonCard: React.FC<{ listing: AddonListing; onOpen(id: AddonId): void }> = ({
  listing,
  onOpen,
}) => {
  const install = useAnyAddonInstall();
  const { entry } = listing;
  const pill = addonPill(listing, install?.id === entry.id ? install : null);
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.id)}
      className="group flex min-w-0 cursor-pointer flex-col items-start gap-1.5 rounded-lg border border-line bg-surface-1 p-4 text-left outline-none transition-colors duration-(--dur-fast) hover:border-fg-faint/60 hover:bg-surface-hover focus-visible:shadow-(--focus-ring)"
    >
      <span className="font-medium text-fg">{entry.name}</span>
      <span className="text-xs leading-relaxed text-fg-faint">{entry.summary}</span>
      <span className="mt-auto flex w-full flex-wrap items-center justify-between gap-2 pt-2">
        <span className="text-2xs tabular-nums text-fg-faint">
          {`${memGB(entry.reserveMiB)} GB memory · ${bytesGB(entry.downloadBytes)} GB download`}
        </span>
        <Pill variant={pill.tone} dot={pill.dot}>
          {pill.label}
        </Pill>
      </span>
    </button>
  );
};

/** Optional services from the stack. Renders nothing when the stack offers none. */
export const AddonsSection: React.FC<{ onOpen(id: AddonId): void }> = ({ onOpen }) => {
  const listings = useAddonListings();
  if (!listings?.length) return null;
  const facts = listings[0]!.facts;
  return (
    <section aria-labelledby="addons-heading" className="flex flex-col gap-3 pt-4">
      <header>
        <h2 id="addons-heading" className="text-title font-medium text-fg">
          Add-ons
        </h2>
        <p className="mt-1 text-xs text-fg-faint">
          Extra services that run beside your assistant on this Mac. Each one comes with the agent
          stack {APP_NAME} installed.
        </p>
      </header>
      {facts.engineMiB > 0 ? (
        <EngineMemoryBar facts={facts} className="max-w-[640px]" />
      ) : (
        <p className="text-xs text-fg-muted">Start the agent stack to see the container engine’s memory.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {listings.map((listing) => (
          <AddonCard key={listing.entry.id} listing={listing} onOpen={onOpen} />
        ))}
      </div>
      <p className="text-2xs text-fg-faint">
        New add-ons appear here when {APP_NAME} updates its stack. Search, documents, automation and
        coding are part of the assistant and always run.
      </p>
    </section>
  );
};
