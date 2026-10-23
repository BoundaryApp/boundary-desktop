import Store from 'electron-store';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';

interface HermesProjectsStoreShape {
  projects: HermesProjectRecord[];
  activeId: string | null;
}

const store = new Store<HermesProjectsStoreShape>({
  name: 'hermes-projects',
  defaults: {
    projects: [],
    activeId: null,
  },
});

export function listStoredHermesProjects(): HermesProjectRecord[] {
  return store.get('projects') ?? [];
}

export function getStoredHermesProject(id: string): HermesProjectRecord | null {
  return listStoredHermesProjects().find((p) => p.id === id) ?? null;
}

export function getActiveHermesProjectId(): string | null {
  return store.get('activeId') ?? null;
}

export function setActiveHermesProjectId(id: string | null): void {
  store.set('activeId', id);
}

export function upsertStoredHermesProject(project: HermesProjectRecord): void {
  const projects = listStoredHermesProjects().filter((p) => p.id !== project.id);
  projects.unshift(project);
  store.set('projects', projects);
}

export function replaceStoredHermesProjects(projects: HermesProjectRecord[]): void {
  store.set('projects', projects);
}

export function removeStoredHermesProject(id: string): void {
  const projects = listStoredHermesProjects().filter((p) => p.id !== id);
  store.set('projects', projects);
  if (store.get('activeId') === id) {
    store.set('activeId', null);
  }
}

/** Test-only: wipe project pin store between cases. */
export function resetHermesProjectsStoreForTests(): void {
  store.set('projects', []);
  store.set('activeId', null);
}
