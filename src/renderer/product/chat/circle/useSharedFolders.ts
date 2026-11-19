import { useCallback, useEffect, useRef, useState } from 'react';
import type { SharedFolderListing } from '../../../../shared/types/sharedFolders';

const api = () => window.electronAPI.circles;

/**
 * The folders shared in one Circle, with what this Mac has of each (ADR 0049). Reloads when main
 * says a folder or an offer changed. `null` until the first list arrives.
 */
export function useSharedFolders(circleKey: string): {
  folders: SharedFolderListing[] | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [folders, setFolders] = useState<SharedFolderListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(circleKey);
  latest.current = circleKey;

  const reload = useCallback(async () => {
    const asked = circleKey;
    const result = await api().foldersList({ key: asked });
    // A reply for a Circle no longer shown is dropped.
    if (latest.current !== asked) return;
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setError(null);
    setFolders(result.folders);
  }, [circleKey]);

  useEffect(() => {
    setFolders(null);
    setError(null);
    void reload();
    return api().onFolderChanged(() => void reload());
  }, [reload]);

  return { folders, error, reload };
}

/**
 * Run `reset` and `load` now, and `load` again whenever main says this folder changed. `load` must
 * be stable (useCallback) so the subscription isn't renewed on every render.
 */
export function useFolderReload(folderKey: string, reset: () => void, load: () => Promise<void>): void {
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    resetRef.current();
    void load();
    return api().onFolderChanged(({ key }) => {
      if (key === folderKey) void load();
    });
  }, [load, folderKey]);
}
