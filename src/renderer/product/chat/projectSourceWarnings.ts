import { useCallback, useSyncExternalStore } from 'react';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
  HermesSourceRow,
} from '../../../shared/types/hermesChat';
import { folderRowView } from './codingFolderView';
import { useCodingFolders, type CodingFoldersState } from './codingFoldersStore';

/**
 * The Project tab's source banners (ADR 0013, 0014 §2), worked out once for the tab and for the
 * inspector toggle's warning dot (ADR 0069 §4).
 */
export interface ProjectSourceWarnings {
  /** An extra folder the agent can't see yet; it hides the other two banners. */
  unmounted: HermesSourceRow | null;
  showWritable: boolean;
  showStale: boolean;
  /** The banner the toggle names, worst first, or null when the tab has none. */
  top: { kind: 'unmounted' | 'writable' | 'stale'; text: string } | null;
}

type Coding = Pick<CodingFoldersState, 'grants' | 'pending' | 'managed'>;

export function projectSourceWarnings(
  project: HermesProjectRecord | null,
  inspect: HermesProjectSourcesInspect | null,
  coding: Coding,
  keptWritable: boolean
): ProjectSourceWarnings {
  const extras = inspect?.sources.filter((row) => !row.isHub) ?? [];
  // A coding folder's own row says how it stands; the banners are for context folders.
  const isCodingRow = (row: HermesSourceRow) =>
    project
      ? folderRowView(row, project, {
          grants: coding.grants,
          pending: coding.pending,
          managed: coding.managed,
        }).coding
      : false;
  const unmounted =
    extras.find((row) => row.visibility === 'unmounted' && !isCodingRow(row)) ?? null;
  const writable = extras.find((row) => row.visibility === 'writable' && !isCodingRow(row));
  const showWritable = Boolean(writable) && !keptWritable && !unmounted;
  const showStale = Boolean(inspect?.stale && extras.length > 0 && !unmounted);
  const next = inspect?.nextStep?.title;
  const top = unmounted
    ? { kind: 'unmounted' as const, text: next ?? `${unmounted.id} isn’t visible yet.` }
    : showWritable
      ? { kind: 'writable' as const, text: next ?? 'This extra folder is writable.' }
      : showStale
        ? { kind: 'stale' as const, text: next ?? 'Index is behind the files.' }
        : null;
  return { unmounted, showWritable, showStale, top };
}

// **Keep** on the Writable banner lasts until the project or a folder's visibility changes. It
// lives outside the tab so closing the inspector doesn't bring the banner (and the dot) back.
let keptKey: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getKeptKey = () => keptKey;

function keepKey(inspect: HermesProjectSourcesInspect | null): string | null {
  if (!inspect) return null;
  return `${inspect.projectId}|${inspect.sources.map((row) => row.visibility).join(',')}`;
}

export function resetKeptWritableForTests(): void {
  keptKey = null;
}

/** The Project tab's banners for `project`, and **Keep** for the Writable one. */
export function useProjectSourceWarnings(
  project: HermesProjectRecord | null,
  inspect: HermesProjectSourcesInspect | null
): ProjectSourceWarnings & { keepWritable: () => void } {
  const coding = useCodingFolders();
  const kept = useSyncExternalStore(subscribe, getKeptKey, getKeptKey);
  const key = keepKey(inspect);
  const keepWritable = useCallback(() => {
    keptKey = key;
    listeners.forEach((listener) => listener());
  }, [key]);
  return {
    ...projectSourceWarnings(project, inspect, coding, key !== null && kept === key),
    keepWritable,
  };
}
