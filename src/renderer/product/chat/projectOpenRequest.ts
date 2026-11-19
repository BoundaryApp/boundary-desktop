import { useSyncExternalStore } from 'react';
import { dispatchAppCommand } from '../useAppShortcuts';

/** A project another screen asked Chat to show, numbered so the same project can be asked for twice. */
export interface ProjectOpenRequest {
  projectId: string;
  seq: number;
}

let request: ProjectOpenRequest | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(next: ProjectOpenRequest | null): void {
  request = next;
  for (const listener of listeners) listener();
}

/** Go to Chat and show a project's page, such as one a shared folder was just added as. */
export function requestOpenProject(projectId: string): void {
  set({ projectId, seq: (request?.seq ?? 0) + 1 });
  dispatchAppCommand('go-chat');
}

export function useProjectOpenRequest(): ProjectOpenRequest | null {
  return useSyncExternalStore(subscribe, () => request);
}

/** Chat has shown the requested project. */
export function clearProjectOpenRequest(seq: number): void {
  if (request?.seq === seq) set(null);
}
