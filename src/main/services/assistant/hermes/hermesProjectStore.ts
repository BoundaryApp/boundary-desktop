import Store from 'electron-store';
import type { HermesProjectRecord } from '../../../../shared/types/hermesChat';
import { readStoreFromMemory } from '../../storeMemoryCache';

interface HermesProjectsStoreShape {
  projects: HermesProjectRecord[];
  activeId: string | null;
}

// Read from memory: the chat list, every turn and every overlay write look projects up here.
const store = readStoreFromMemory(
  new Store<HermesProjectsStoreShape>({
    name: 'hermes-projects',
    defaults: {
      projects: [],
      activeId: null,
    },
  })
);

/** Copies of the stored records, so a caller that changes one without saving changes nothing. */
export function listStoredHermesProjects(): HermesProjectRecord[] {
  return (store.get('projects') ?? []).map((project) => ({ ...project }));
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

export function removeStoredHermesProject(id: string): void {
  store.set('projects', listStoredHermesProjects().filter((p) => p.id !== id));
}

export function replaceStoredHermesProjects(projects: HermesProjectRecord[]): void {
  store.set('projects', projects);
}

/** Test-only: wipe project pin store between cases. */
export function resetHermesProjectsStoreForTests(): void {
  store.set('projects', []);
  store.set('activeId', null);
}
