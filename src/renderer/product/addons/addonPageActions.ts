import { useEffect, useRef, useState } from 'react';
import type { AddonId, AddonInstallSnapshot, AddonListing } from '../../../shared/types/addons';
import { addonPill, engineDown, inProgress } from './addonCopy';
import { forgetAddonInstall, reloadAddons } from './useAddons';

// What the script add-ons' pages (Actual, Bitwarden, Email) share: an IPC call that answers with a line to show, one
// action at a time with a busy flag and an error or note, and reading the add-on's state again
// when the page opens, when a run ends and when the stack becomes ready.

/** Runs an IPC call; a failure comes back as the line to show. */
export async function callIpc<T extends { success: boolean; error?: string }>(
  work: () => Promise<T>,
  fallback: string
): Promise<T | string> {
  try {
    const result = await work();
    return result.success ? result : (result.error ?? fallback);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * One action at a time on an add-on's page. `act` runs `work`, which resolves to a line to show
 * or null, then calls `settled`, forgets a finished run and reads the listings and `refresh` again.
 */
export function useAddonActions(id: AddonId, refresh: () => Promise<void>, settled: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    let failure: string | null;
    try {
      failure = await work();
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    setBusy(false);
    settled();
    setError(failure);
    forgetAddonInstall(id);
    void reloadAddons();
    void refresh();
  };
  return { busy, error, note, setError, setNote, act };
}

/** Reads the add-on's state when the page opens and each time a run ends, then calls `ended`. */
export function useRefreshOnOpen(
  install: AddonInstallSnapshot | null,
  refresh: () => Promise<void>,
  ended?: (run: AddonInstallSnapshot) => void
): void {
  const done = Boolean(install?.done);
  const lastDone = useRef(done);
  const first = useRef(refresh);
  useEffect(() => {
    void first.current();
  }, []);
  useEffect(() => {
    if (done && !lastDone.current) {
      void refresh();
      if (install) ended?.(install);
    }
    lastDone.current = done;
  }, [done, install, refresh, ended]);
}

/** Runs `run` each time the stack becomes ready, while this stack has the add-on. */
export function useWhenStackReady(phase: string, available: boolean, run: () => Promise<void>): void {
  const last = useRef(phase);
  useEffect(() => {
    const was = last.current;
    last.current = phase;
    if (available && phase === 'ready' && was !== 'ready') void run();
  }, [phase, available, run]);
}

/** A script add-on page's state: whether a run is under way, the stack is down, it's on, Get can run, and its pill. */
export function addonPageState(listing: AddonListing, install: AddonInstallSnapshot | null) {
  const down = engineDown(listing);
  return {
    running: inProgress(install),
    down,
    on: listing.installed,
    canGet: !down && listing.fit.verdict !== 'over',
    pill: addonPill(listing, install, 0),
  };
}

/**
 * Work for `act` that turns the add-on on (`start`) or off; `done` sets the page's note once it
 * worked. Resolves to the line to show on failure, or null.
 */
export function switchAddon(id: AddonId, name: string, on: boolean, done: () => void): () => Promise<string | null> {
  return async () => {
    const result = await callIpc(
      () => (on ? window.electronAPI.addons.start(id) : window.electronAPI.addons.turnOff(id)),
      `Couldn’t turn ${on ? 'on' : 'off'} ${name}.`
    );
    if (typeof result === 'string') return result;
    done();
    return null;
  };
}
