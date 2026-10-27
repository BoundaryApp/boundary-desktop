import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setActiveProject = vi.fn().mockResolvedValue(undefined);
const recreate = vi.fn().mockResolvedValue({ success: true });

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    setActiveProject: (...args: unknown[]) => setActiveProject(...args),
    listProjects: vi.fn().mockResolvedValue({ projects: [], activeId: null }),
  }),
}));

vi.mock('../../AssistantStackService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../AssistantStackService')>()),
  recreateHermesForProjectMounts: () => recreate(),
}));

vi.mock('../hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesProjectsOverlay')>()),
  writeHermesProjectsOverlay: vi.fn(),
  ensureProjectMountPoints: vi.fn(),
}));

vi.mock('../../coding/codingMounts', () => ({ persistCodingStackEnv: vi.fn() }));

import { applyFirstRunHermesProjects, stageHostFolderHermesProjects } from '../hermesProjects';
import {
  getActiveHermesProjectId,
  listStoredHermesProjects,
  resetHermesProjectsStoreForTests,
} from '../hermesProjectStore';
import {
  recordMountedProjectFolders,
  resetMountedProjectFoldersForTests,
} from '../projectMountState';

let tmp: string;
let garden: string;
let notes: string;

describe('first-run projects (first-run spec, Phase 2)', () => {
  beforeEach(() => {
    resetHermesProjectsStoreForTests();
    resetMountedProjectFoldersForTests();
    setActiveProject.mockClear();
    recreate.mockClear();
    recreate.mockResolvedValue({ success: true });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-projects-'));
    garden = path.join(tmp, 'garden-planner');
    notes = path.join(tmp, 'notes');
    fs.mkdirSync(garden);
    fs.mkdirSync(notes);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stages each folder once, reusing a folder that is already a project', () => {
    const first = stageHostFolderHermesProjects([garden, notes]);
    const again = stageHostFolderHermesProjects([garden]);
    expect(first.map((project) => project.name)).toEqual(['garden-planner', 'notes']);
    expect(again[0].id).toBe(first[0].id);
    expect(listStoredHermesProjects()).toHaveLength(2);
  });

  it('lists both projects and selects the first, with no recreate when `up` mounted them', async () => {
    stageHostFolderHermesProjects([garden, notes]);
    recordMountedProjectFolders([garden, notes]);

    const result = await applyFirstRunHermesProjects([
      { kind: 'host-folder', hostPath: garden },
      { kind: 'host-folder', hostPath: notes },
    ]);

    expect(result.success).toBe(true);
    expect(recreate).not.toHaveBeenCalled();
    const projects = listStoredHermesProjects();
    expect(projects.map((project) => project.name).sort()).toEqual(['garden-planner', 'notes']);
    const gardenProject = projects.find((project) => project.name === 'garden-planner')!;
    expect(result.activeId).toBe(gardenProject.id);
    expect(getActiveHermesProjectId()).toBe(gardenProject.id);
    // The first pick is activated last, so the gateway ends on it too.
    expect(setActiveProject.mock.calls.at(-1)?.[0]).toBe(gardenProject.hermesProjectId);
  });

  it('recreates once when the running container lacks the folders', async () => {
    recordMountedProjectFolders([garden]);
    const result = await applyFirstRunHermesProjects([
      { kind: 'host-folder', hostPath: garden },
      { kind: 'host-folder', hostPath: notes },
    ]);
    expect(result.success).toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it('drops the projects the recreate failed to mount and returns the error', async () => {
    recordMountedProjectFolders([garden]);
    recreate.mockResolvedValue({ success: false, error: 'compose exploded' });
    const result = await applyFirstRunHermesProjects([
      { kind: 'host-folder', hostPath: garden },
      { kind: 'host-folder', hostPath: notes },
    ]);
    expect(result.success).toBe(false);
    expect(result.error).toContain('compose exploded');
    // Garden is already in the running container, so only notes goes.
    expect(listStoredHermesProjects().map((project) => project.name)).toEqual(['garden-planner']);
    expect(setActiveProject).not.toHaveBeenCalled();
  });
});
