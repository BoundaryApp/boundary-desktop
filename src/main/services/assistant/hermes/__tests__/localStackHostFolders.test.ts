import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recreate = vi.fn().mockResolvedValue({ success: true });
const writeOverlay = vi.fn();

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    setActiveProject: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue({ projects: [], activeId: null }),
  }),
}));

vi.mock('../../AssistantStackService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../AssistantStackService')>()),
  recreateHermesForProjectMounts: () => recreate(),
}));

vi.mock('../hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesProjectsOverlay')>()),
  writeHermesProjectsOverlay: (...args: unknown[]) => writeOverlay(...args),
  ensureProjectMountPoints: vi.fn(),
}));

vi.mock('../../coding/codingMounts', () => ({ persistCodingStackEnv: vi.fn() }));

vi.mock('../../localStackMode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../localStackMode')>()),
  isLocalAssistantStackMode: () => true,
}));

import {
  applyFirstRunHermesProjects,
  changeHermesProjectFolder,
  createEmptyHermesProject,
  createHostFolderHermesProject,
  syncOverlayAndRecreate,
} from '../hermesProjects';
import { listStoredHermesProjects, resetHermesProjectsStoreForTests } from '../hermesProjectStore';
import { areProjectFoldersMounted, resetMountedProjectFoldersForTests } from '../projectMountState';

let tmp: string;
let folder: string;

describe('host-folder projects in local-stack mode (G09-8)', () => {
  beforeEach(() => {
    resetHermesProjectsStoreForTests();
    resetMountedProjectFoldersForTests();
    recreate.mockClear();
    writeOverlay.mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-stack-folders-'));
    folder = path.join(tmp, 'garden-planner');
    fs.mkdirSync(folder);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to create one, without saving it or recreating Hermes', async () => {
    const result = await createHostFolderHermesProject({ hostPath: folder });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local agent stack/);
    expect(listStoredHermesProjects()).toEqual([]);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('refuses to point a project at a host folder', async () => {
    const created = await createEmptyHermesProject({ name: 'Notes' });
    expect(created.success).toBe(true);
    const result = await changeHermesProjectFolder({
      projectId: created.project!.id,
      hostPath: folder,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local agent stack/);
    expect(listStoredHermesProjects()[0].kind).toBe('empty');
    expect(recreate).not.toHaveBeenCalled();
  });

  it('refuses the setup flow’s folder picks', async () => {
    const result = await applyFirstRunHermesProjects([{ kind: 'host-folder', hostPath: folder }]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local agent stack/);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('does not record host folders as mounted after a context-root remount', async () => {
    const { upsertStoredHermesProject } = await import('../hermesProjectStore');
    upsertStoredHermesProject({
      id: 'p1',
      name: 'garden-planner',
      hostPath: folder,
      containerPath: '/opt/projects/garden-planner',
      slug: 'garden-planner',
      kind: 'host-folder',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect((await syncOverlayAndRecreate()).success).toBe(true);
    expect(areProjectFoldersMounted([folder])).toBe(false);
  });
});
