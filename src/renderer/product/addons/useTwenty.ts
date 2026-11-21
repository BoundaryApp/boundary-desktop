import type { TwentyWorkspace } from '../../../shared/types/addons';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import { errorText } from '../../components/ui/use-sheet-action';
import { callIpc } from './addonPageActions';

// Twenty's workspace files and the changes that wait for an assistant restart, shared by the
// detail page and the catalog card. The files never carry a key: main reports only whether
// each key line is set.

const workspaces = createIpcStore<TwentyWorkspace[] | null>({
  initial: null,
  start: () => void reloadTwenty(),
});

/** Reads the workspace files again, after a connect, disconnect, access change or turn on/off. */
export async function reloadTwenty(): Promise<void> {
  try {
    workspaces.set(await window.electronAPI.addons.twenty.workspaces());
    readError.set(null);
  } catch (error) {
    // Keep the last list; the page says the read failed.
    readError.set(errorText(error));
  }
}

const readError = createIpcStore<string | null>({ initial: null });

/** Why the workspace files couldn't be read, or null. */
export function useTwentyReadError(): string | null {
  return useIpcStore(readError);
}

/** The workspaces, or null until the first read. */
export function useTwentyWorkspaces(): TwentyWorkspace[] | null {
  return useIpcStore(workspaces);
}

const pending = createIpcStore<string[]>({
  initial: [],
  start: (store) => {
    window.electronAPI.addons.onPendingChanged((next) => {
      store.set(next);
      void reloadTwenty();
    });
    void window.electronAPI.addons
      .pending()
      .then((current) => store.set(current))
      .catch((): void => undefined);
  },
});

/** The changes that take effect at the next assistant restart, one line each. */
export function usePendingChanges(): string[] {
  return useIpcStore(pending);
}

const moveHidden = createIpcStore<boolean>({ initial: false });

/** Whether Keep both hid the move steps. Kept until the window reloads. */
export function useMoveStepsHidden(): boolean {
  return useIpcStore(moveHidden);
}

export function hideMoveSteps(): void {
  moveHidden.set(true);
}

/** The hosted workspaces; each is a `crm-<slug>` of its own and nothing runs here for them. */
export const hostedOf = (all: TwentyWorkspace[] | null): TwentyWorkspace[] => (all ?? []).filter((w) => !w.local);

export const agentName = (workspace: Pick<TwentyWorkspace, 'slug'>): string => `crm-${workspace.slug}`;

/** Opens the local Twenty signed in as its owner. Resolves to a line to show, or null. */
export async function openLocalTwenty(): Promise<string | null> {
  const result = await callIpc(() => window.electronAPI.addons.twenty.open(), 'Couldn’t open Twenty.');
  return typeof result === 'string' ? result : (result.warning ?? null);
}
