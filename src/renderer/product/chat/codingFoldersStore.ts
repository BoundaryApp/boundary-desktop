import type {
  CodingAgentBusy,
  CodingCreateFolderResult,
  CodingFoldersResult,
  CodingGrantPayload,
  CodingGrantRow,
} from '../../../shared/types/codingFolders';
import { checklistStepFor, folderKey, type CodingPending } from './codingFolderView';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';

/**
 * Coding-folder state shared by the Project tab and the add sheet (ADR 0028): the grant list,
 * which folders are connecting or queued, the Connecting checklist step, and the last error.
 */

export interface CodingFoldersState {
  loaded: boolean;
  managed: boolean;
  command: string | null;
  grants: CodingGrantRow[];
  pending: Record<string, CodingPending>;
  /** Connecting checklist: 0 saved, 1 restarting, 2 checking. */
  step: 0 | 1 | 2 | null;
  /** Titles of the coding tasks a queued change is waiting for. */
  waitingFor: string[];
  error: { hostPath: string | null; message: string } | null;
}

const initial: CodingFoldersState = {
  loaded: false,
  managed: true,
  command: null,
  grants: [],
  pending: {},
  step: null,
  waitingFor: [],
  error: null,
};

const store = createIpcStore<CodingFoldersState>({
  initial,
  start: () => {
    window.electronAPI.codingFolders.onProgress((message) => {
      const step = checklistStepFor(message);
      if (step !== null && Object.values(store.get().pending).includes('connecting')) {
        setState({ step });
      }
    });
    void refreshCodingFolders();
  },
});
const changeListeners = new Set<() => void>();

function setState(patch: Partial<CodingFoldersState>): void {
  store.update((state) => ({ ...state, ...patch }));
}

export function useCodingFolders(): CodingFoldersState {
  return useIpcStore(store);
}

export function getCodingFoldersState(): CodingFoldersState {
  return store.get();
}

/** Called after every grant change so the screen can re-read the project's sources. */
export function onCodingGrantsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}

function applyResult(result: CodingFoldersResult): void {
  setState({
    loaded: true,
    managed: result.managed,
    command: result.command ?? null,
    grants: result.managed ? result.grants : [],
  });
}

export async function refreshCodingFolders(): Promise<void> {
  try {
    applyResult(await window.electronAPI.codingFolders.list());
  } catch {
    setState({ loaded: true });
  }
}

function withPending(paths: readonly string[], kind: CodingPending | null) {
  const pending = { ...store.get().pending };
  for (const item of paths) {
    const key = folderKey(item);
    if (kind) pending[key] = kind;
    else delete pending[key];
  }
  return pending;
}

/**
 * Run a grant change with the folders shown as Connecting, then apply the new grant list.
 * The operation decides whether to stop a running task; callers check busy first.
 */
export async function runCodingChange(
  paths: readonly string[],
  operation: () => Promise<CodingFoldersResult>
): Promise<CodingFoldersResult> {
  setState({ pending: withPending(paths, 'connecting'), step: 0, error: null });
  let result: CodingFoldersResult;
  try {
    result = await operation();
  } catch (error) {
    result = {
      success: false,
      managed: store.get().managed,
      grants: store.get().grants,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  applyResult(result);
  const pending = withPending(paths, null);
  setState({
    pending,
    step: Object.values(pending).includes('connecting') ? store.get().step : null,
    error:
      !result.success && result.error && !result.busy
        ? { hostPath: paths[0] ?? null, message: result.error }
        : null,
  });
  for (const listener of changeListeners) listener();
  return result;
}

interface QueuedChange {
  paths: readonly string[];
  run: (stopRunningTask: boolean) => Promise<CodingFoldersResult>;
  resolve: (result: CodingFoldersResult) => void;
  forced: boolean;
}

/**
 * Whether a coding task is running. A rejected call counts as not busy: main checks again
 * before a grant and answers with `busy`, which the caller then shows.
 */
export function readCodingAgentBusy(): Promise<CodingAgentBusy> {
  return window.electronAPI.codingFolders
    .busy()
    .catch((): CodingAgentBusy => ({ busy: false, sessions: [] }));
}

const queue: QueuedChange[] = [];
let polling = false;

const CODING_QUEUE_POLL_MS = 5_000;

async function pollQueue(pollMs: number): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    while (queue.length > 0) {
      const next = queue[0];
      if (!next.forced) {
        const busy = await readCodingAgentBusy();
        if (busy.busy) {
          setState({ waitingFor: busy.sessions });
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
      }
      queue.shift();
      setState({ waitingFor: [], pending: withPending(next.paths, null) });
      const result = await runCodingChange(next.paths, () => next.run(next.forced));
      next.resolve(result);
    }
  } finally {
    polling = false;
    setState({ waitingFor: [] });
  }
}

/**
 * Run the change once no coding task is running ("Add when it finishes"). The folders show
 * as Queued meanwhile. `stopRunningTask` is passed as false, unless the user forces it.
 */
export function queueCodingChange(
  paths: readonly string[],
  run: (stopRunningTask: boolean) => Promise<CodingFoldersResult>,
  pollMs = CODING_QUEUE_POLL_MS
): Promise<CodingFoldersResult> {
  return new Promise((resolve) => {
    queue.push({ paths, run, resolve, forced: false });
    setState({ pending: withPending(paths, 'queued') });
    void pollQueue(pollMs);
  });
}

/** Add now, stop the running task and add, or add when it finishes. */
export type CodingChangeMode = 'now' | 'stop' | 'queue';

/** A grant change; `stopRunningTask` is true only for "Stop task and add". */
export type CodingChangeRun<R extends CodingFoldersResult = CodingFoldersResult> = (
  stopRunningTask: boolean
) => Promise<R>;

/** Run a grant change in the way the user chose. */
export function codingChange<R extends CodingFoldersResult>(
  paths: readonly string[],
  mode: CodingChangeMode,
  run: CodingChangeRun<R>
): Promise<R> {
  return (
    mode === 'queue'
      ? queueCodingChange(paths, run)
      : runCodingChange(paths, () => run(mode === 'stop'))
  ) as Promise<R>;
}

/** Grant coding access to a folder, then list it in the project once the grant is in. */
export function grantAndList(
  payload: Omit<CodingGrantPayload, 'stopRunningTask'>
): CodingChangeRun {
  return async (stopRunningTask) => {
    const result = await window.electronAPI.codingFolders.grant({ ...payload, stopRunningTask });
    if (payload.projectId && result.grants.some((grant) => grant.resource === payload.hostPath)) {
      await window.electronAPI.projects.addSourceFolder({
        projectId: payload.projectId,
        hostPath: payload.hostPath,
      });
    }
    return result;
  };
}

/** Create a folder with a coding grant, then list it in the project once the grant is in. */
export function createAndList(payload: {
  projectId: string | null;
  parent: string;
  name: string;
  initGit: boolean;
}): CodingChangeRun<CodingCreateFolderResult> {
  return async (stopRunningTask) => {
    const result = await window.electronAPI.codingFolders.createFolder({
      ...payload,
      grant: true,
      stopRunningTask,
    });
    const hostPath = result.hostPath;
    if (
      payload.projectId &&
      hostPath &&
      result.grants.some((grant) => grant.resource === hostPath)
    ) {
      await window.electronAPI.projects.addSourceFolder({ projectId: payload.projectId, hostPath });
    }
    return result;
  };
}

/** "Stop task and add now" for everything queued. */
export function forceQueuedCodingChanges(): void {
  for (const item of queue) item.forced = true;
}

/** Apply a result from a call made outside runCodingChange, and tell listeners. */
export function applyCodingFoldersResult(result: CodingFoldersResult): void {
  applyResult(result);
  for (const listener of changeListeners) listener();
}

export function dismissCodingError(): void {
  setState({ error: null });
}

/** Test-only. */
export function resetCodingFoldersStoreForTests(): void {
  store.reset();
  queue.length = 0;
  polling = false;
  changeListeners.clear();
}
