import { useSyncExternalStore } from 'react';
import type {
  CodingAgentBusy,
  CodingFoldersResult,
  CodingGrantRow,
} from '../../../shared/types/codingFolders';
import { hermesChatIPC } from '../../services/hermesChatIPCService';
import { checklistStepFor, folderKey, type CodingPending } from './codingFolderView';

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

let state: CodingFoldersState = initial;
const listeners = new Set<() => void>();
const changeListeners = new Set<() => void>();
let progressUnsubscribe: (() => void) | null = null;

function setState(patch: Partial<CodingFoldersState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!progressUnsubscribe) {
    try {
      progressUnsubscribe = hermesChatIPC.onCodingFoldersProgress((message) => {
        const step = checklistStepFor(message);
        if (step !== null && Object.values(state.pending).includes('connecting')) {
          setState({ step });
        }
      });
    } catch {
      progressUnsubscribe = () => undefined;
    }
  }
  if (!state.loaded) void refreshCodingFolders();
  return () => {
    listeners.delete(listener);
  };
}

export function useCodingFolders(): CodingFoldersState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  );
}

export function getCodingFoldersState(): CodingFoldersState {
  return state;
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
    applyResult(await hermesChatIPC.listCodingFolders());
  } catch {
    setState({ loaded: true });
  }
}

function withPending(paths: readonly string[], kind: CodingPending | null) {
  const pending = { ...state.pending };
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
      managed: state.managed,
      grants: state.grants,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  applyResult(result);
  const pending = withPending(paths, null);
  setState({
    pending,
    step: Object.values(pending).includes('connecting') ? state.step : null,
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

const queue: QueuedChange[] = [];
let polling = false;

export const CODING_QUEUE_POLL_MS = 5_000;

async function pollQueue(pollMs: number): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    while (queue.length > 0) {
      const next = queue[0];
      if (!next.forced) {
        const busy = await hermesChatIPC
          .codingAgentBusy()
          .catch((): CodingAgentBusy => ({ busy: false, sessions: [] }));
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
  state = initial;
  queue.length = 0;
  polling = false;
  progressUnsubscribe = null;
  listeners.clear();
  changeListeners.clear();
}
