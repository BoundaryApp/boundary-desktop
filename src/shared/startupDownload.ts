import type { ComposeProgressEvent } from './assistantStackLifecycle';

/**
 * Byte totals for image layers pulled during `compose up` (ADR 0029). Compose
 * reports each layer's size only once that layer starts, so the total grows
 * during the pull and is never shown as a target.
 */

export interface DownloadLayer {
  current: number;
  total: number;
}

export type DownloadTally = Readonly<Record<string, DownloadLayer>>;

export interface StartupDownload {
  receivedBytes: number;
  /** Sum of the layer sizes seen so far, not the size of the whole pull. */
  seenBytes: number;
}

const LAYER_DONE = /download complete|pull complete|already exists|verifying checksum|extracting/i;

/** Folds one Compose progress event into the tally; returns the same object when nothing changed. */
export function tallyDownload(tally: DownloadTally, event: ComposeProgressEvent): DownloadTally {
  const id = typeof event.id === 'string' ? event.id : '';
  // Layer events name an image as their parent; service and image rows don't count.
  if (!id || typeof event.parent_id !== 'string' || /^image\s+/i.test(id)) return tally;
  const prev = tally[id];
  const text = String(event.text ?? '');
  const total = typeof event.total === 'number' && event.total > 0 ? event.total : prev?.total ?? 0;
  if (!total) return tally;
  const current = LAYER_DONE.test(text)
    ? total
    : typeof event.current === 'number'
      ? Math.min(total, Math.max(prev?.current ?? 0, event.current))
      : (prev?.current ?? 0);
  if (prev && prev.current === current && prev.total === total) return tally;
  return { ...tally, [id]: { current, total } };
}

export function summarizeDownload(tally: DownloadTally): StartupDownload {
  let receivedBytes = 0;
  let seenBytes = 0;
  for (const layer of Object.values(tally)) {
    receivedBytes += layer.current;
    seenBytes += layer.total;
  }
  return { receivedBytes, seenBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}
