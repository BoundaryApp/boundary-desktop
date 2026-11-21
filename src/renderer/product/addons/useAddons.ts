import type {
  ActualConnectInput,
  AddonId,
  AddonInstallSnapshot,
  AddonListing,
  AddonStepId,
  TwentyAccess,
} from '../../../shared/types/addons';
import type { RunningWorkItem } from '../../../shared/types/updates';
import { useEffect, useRef, useState } from 'react';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import { errorText } from '../../components/ui/use-sheet-action';
import { removalSteps } from './addonCopy';
import { lineFromIpc } from './addonPageActions';

// The add-on catalog and the installer's snapshot, shared by the Services list, the detail
// page and the install view. `addons:install` resolves only when the run ends, and a failed
// step resolves it too, so the screens follow the snapshot alone.

const listings = createIpcStore<AddonListing[] | null>({
  initial: null,
  start: () => void reloadAddons(),
});

/** Reads the catalog again: after an install, turn off or removal changes what's installed. */
export async function reloadAddons(): Promise<void> {
  try {
    listings.set(await window.electronAPI.addons.list());
  } catch (error) {
    // Keep the last list; with none, the section stays hidden. Main logs its own failures;
    // this covers a call that never reached it.
    console.warn('[addons] list failed', errorText(error));
  }
}

const install = createIpcStore<AddonInstallSnapshot | null>({
  initial: null,
  start: (store) => {
    let heard = false;
    window.electronAPI.addons.onProgress((next) => {
      heard = true;
      const before = store.get();
      store.set(next);
      if (next.done !== before?.done || restartStatus(next) !== restartStatus(before)) {
        void reloadAddons();
      }
    });
    // Progress events don't replay, and none fires while the restart step waits.
    void window.electronAPI.addons
      .snapshot()
      .then((current) => {
        // A null reply must not blank an install this window already started.
        if (!heard && (current || !store.get())) store.set(current);
      })
      .catch((): void => undefined);
  },
});

const restartStatus = (s: AddonInstallSnapshot | null) =>
  s?.steps.find((step) => step.id === 'restart')?.status;

export function useAddonListings(): AddonListing[] | null {
  return useIpcStore(listings);
}

export function useAddonListing(id: AddonId): AddonListing | null {
  return useAddonListings()?.find((l) => l.entry.id === id) ?? null;
}

/** The installer's snapshot for `id`, or null when nothing has run for it. */
export function useAddonInstall(id: AddonId): AddonInstallSnapshot | null {
  const current = useIpcStore(install);
  return current?.id === id ? current : null;
}

export function useAnyAddonInstall(): AddonInstallSnapshot | null {
  return useIpcStore(install);
}

const STEP_IDS: AddonStepId[] = ['check', 'download', 'start', 'answer', 'setup', 'restart'];

/**
 * Starts an install. The installer's first snapshot has every step pending; showing one now
 * keeps the view from flashing empty. A refused call (another run holds the installer) shows
 * as a failed check.
 */
export function startAddonInstall(id: AddonId, access?: TwentyAccess, makeRoom = false): void {
  // The installer writes the access choice into `crm-main` before its restart step (0023 R1).
  // `makeRoom` lets it restart the engine at a size that fits first (ADR 0055 §3).
  const options = { ...(access ? { access } : {}), ...(makeRoom ? { makeRoom } : {}) };
  runInstall(id, STEP_IDS, () =>
    Object.keys(options).length
      ? window.electronAPI.addons.install(id, options)
      : window.electronAPI.addons.install(id)
  );
}

/**
 * Connects Actual's first budget on another server while the add-on is off. Turning Actual on
 * the first time builds its MCP images, so this runs as an install and the page shows its steps.
 */
export function startActualRemoteInstall(input: ActualConnectInput): void {
  runInstall('actual', ['check', 'download', 'start', 'connect'], () =>
    window.electronAPI.addons.install('actual', { remote: input })
  );
}

/**
 * Turns email on with its first account (spec decision 36). The stack's `enable` refuses
 * without an account that has mailboxes, so the sheet saves the account first and this runs
 * the steps the email installer reports.
 */
export function startEmailInstall(account: string): void {
  runInstall('email', ['check', 'start', 'setup'], () => window.electronAPI.addons.install('email', { email: { account } }));
}

function runInstall(
  id: AddonId,
  steps: AddonStepId[],
  call: () => Promise<{ success: boolean; error?: string }>
): void {
  install.set({ id, kind: 'install', steps: steps.map((step) => ({ id: step, status: 'pending' })), done: false });
  const refused = (message: string) => {
    const current = install.get();
    if (current?.id !== id || current.error) return;
    install.set({
      ...current,
      steps: current.steps.map((s) => (s.id === 'check' && s.status === 'pending' ? { ...s, status: 'error' } : s)),
      error: { step: 'check', message, logTail: [] },
    });
  };
  call().then(
    (result) => {
      if (!result.success) refused(result.error ?? 'The install didn’t start.');
      void reloadAddons();
    },
    (error: unknown) => refused(errorText(error))
  );
}

/**
 * Starts a removal, or resumes a failed one. As with an install, the first snapshot is ours so
 * the view isn't empty, and a refused call (local stack, another run holds the installer)
 * shows as a failed first step. A run that fails a step still resolves; the snapshot says so.
 */
export function startAddonRemoval(id: AddonId, installed: boolean, deleteImages: boolean): void {
  const ids = removalSteps(installed, deleteImages, id);
  install.set({ id, kind: 'remove', steps: ids.map((step) => ({ id: step, status: 'pending' })), done: false });
  const refused = (message: string) => {
    const current = install.get();
    if (current?.id !== id || current.kind !== 'remove' || current.error) return;
    install.set({
      ...current,
      steps: current.steps.map((s, i) => (i === 0 ? { ...s, status: 'error' } : s)),
      error: { step: ids[0]!, message, logTail: [] },
    });
  };
  window.electronAPI.addons.remove(id, { deleteImages }).then(
    (result) => {
      if (!result.success) refused(result.error ?? 'The removal didn’t start.');
      void reloadAddons();
    },
    (error: unknown) => refused(errorText(error))
  );
}

/**
 * Asks main to cancel the running install or removal. Resolves with an error message when main
 * refuses, as when the run has just passed the last step that can be cancelled.
 */
export function cancelAddonRun(id: AddonId): Promise<string | null> {
  return lineFromIpc(() => window.electronAPI.addons.cancel(id), 'Couldn’t cancel.');
}

/** Main drops its snapshot after undo and turn off without sending one. */
export function forgetAddonInstall(id: AddonId): void {
  if (install.get()?.id === id) install.set(null);
}

// An installed add-on whose server isn't running while the stack is ready (`stopped`): the
// alert on every screen and the detail page offer Start, or Mark as not installed (Turn off).
// Both read one action state, so a start begun in one shows in the other.

export interface StoppedAction {
  doing: 'starting' | 'marking' | null;
  error: string | null;
}

const IDLE: StoppedAction = { doing: null, error: null };

const stoppedActions = createIpcStore<Partial<Record<AddonId, StoppedAction>>>({ initial: {} });
/** Add-ons whose alert was put off until the next launch. The detail page still offers both. */
const later = createIpcStore<AddonId[]>({ initial: [] });

/** Installed add-ons whose server isn't running, without one an install is working on. */
export function useStoppedAddons(): AddonListing[] {
  const all = useAddonListings();
  const current = useIpcStore(install);
  return (all ?? []).filter(
    (l) => l.installed && l.stopped && !(current?.id === l.entry.id && inProgressSnapshot(current))
  );
}

/** Stopped add-ons whose alert hasn't been put off. */
export function useStoppedAddonAlerts(): AddonListing[] {
  const hidden = useIpcStore(later);
  const actions = useIpcStore(stoppedActions);
  // One that's starting stays, so its progress and any error stay in view.
  return useStoppedAddons().filter((l) => !hidden.includes(l.entry.id) || actions[l.entry.id]?.doing);
}

export function useStoppedAction(id: AddonId): StoppedAction {
  return useIpcStore(stoppedActions)[id] ?? IDLE;
}

const inProgressSnapshot = (s: AddonInstallSnapshot) => !s.done;

function setAction(id: AddonId, next: StoppedAction): void {
  stoppedActions.update((all) => ({ ...all, [id]: next }));
}

async function runStoppedAction(
  id: AddonId,
  doing: 'starting' | 'marking',
  call: () => Promise<{ success: boolean; error?: string }>,
  fallback: string
): Promise<void> {
  if (stoppedActions.get()[id]?.doing) return;
  setAction(id, { doing, error: null });
  setAction(id, { doing: null, error: await lineFromIpc(call, fallback) });
  await reloadAddons();
}

/** Starts a stopped add-on's containers; the assistant restarts once its server answers. */
export function startStoppedAddon(id: AddonId, name: string): Promise<void> {
  return runStoppedAction(id, 'starting', () => window.electronAPI.addons.start(id), `${name} didn’t start.`);
}

/** Records a stopped add-on as not installed, as Turn off does. Its data stays. */
export function markAddonNotInstalled(id: AddonId, name: string): Promise<void> {
  return runStoppedAction(
    id,
    'marking',
    () => window.electronAPI.addons.turnOff(id),
    `Couldn’t mark ${name} as not installed.`
  ).then(() => forgetAddonInstall(id));
}

/** Hides the alert until the next launch. */
export function putOffStoppedAlert(id: AddonId): void {
  later.update((ids) => (ids.includes(id) ? ids : [...ids, id]));
}

/**
 * Reads the catalog again each time the stack becomes ready. `stopped` is only reported once
 * it is, so a list read during start-up would otherwise never show it.
 */
export function useReloadAddonsWhenReady(phase: string): void {
  const last = useRef(phase);
  useEffect(() => {
    const was = last.current;
    last.current = phase;
    if (phase === 'ready' && was !== 'ready') void reloadAddons();
  }, [phase]);
}


/** How often "Restart when the task finishes" asks whether agent work still runs. */
const WORK_POLL_MS = 5000;

/** Agent work that a restart would stop, read when `active` turns true. */
export function useRunningWork(active: boolean): RunningWorkItem[] {
  const [items, setItems] = useState<RunningWorkItem[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    window.electronAPI.addons
      .runningWork()
      .then((next) => {
        if (alive) setItems(next);
      })
      .catch((): void => undefined);
    return () => {
      alive = false;
    };
  }, [active]);
  return items;
}

/** "Restart when the task finishes": while `queued` and `waiting`, asks until no work runs, then calls `fire` once. */
export function useRestartWhenIdle(queued: boolean, waiting: boolean, fire: () => void): void {
  const latest = useRef(fire);
  latest.current = fire;
  useEffect(() => {
    if (!queued || !waiting) return;
    let fired = false;
    const timer = setInterval(() => {
      void window.electronAPI.addons
        .runningWork()
        .then((work) => {
          if (fired || work.length) return;
          fired = true;
          clearInterval(timer);
          latest.current();
        })
        .catch((): void => undefined);
    }, WORK_POLL_MS);
    return () => clearInterval(timer);
  }, [queued, waiting]);
}
