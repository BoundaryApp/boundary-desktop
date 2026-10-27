import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';

const recreate = vi.fn();
const writeOverlay = vi.fn();
const gatewayList = vi.fn();
let envRoot = '';

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    setActiveProject: vi.fn().mockResolvedValue(undefined),
    listProjects: () => gatewayList(),
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

vi.mock('../../coding/codingMounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coding/codingMounts')>()),
  persistCodingStackEnv: vi.fn(),
}));

vi.mock('../../resolveAssistantRoot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../resolveAssistantRoot')>()),
  resolveActiveAssistantRoot: () => envRoot,
}));

import { readAssistantEnvFile, resolveAssistantUserContentRoot } from '../../assistantPaths';
import {
  resetCodingRemountQueueForTests,
  scheduleCodingRemount,
  setCodingGrantDepsForTests,
} from '../../coding/codingGrants';
import { resetCodingGrantStoreForTests } from '../../coding/codingGrantStore';
import {
  changeHermesProjectFolder,
  createHostFolderHermesProject,
  listHermesProjects,
  syncOverlayAndRecreate,
} from '../hermesProjects';
import { addHermesProjectSourceFolder } from '../hermesProjectSources';
import { SOURCES_NAME } from '../projectSourcesModel';
import {
  getActiveHermesProjectId,
  listStoredHermesProjects,
  resetHermesProjectsStoreForTests,
  setActiveHermesProjectId,
  upsertStoredHermesProject,
} from '../hermesProjectStore';

let tmp: string;

function dir(...parts: string[]): string {
  const full = path.join(tmp, ...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function hostProject(partial: Partial<HermesProjectRecord> = {}): HermesProjectRecord {
  return {
    id: 'garden-id',
    name: 'Garden',
    hostPath: dir('garden'),
    containerPath: '/opt/projects/garden',
    slug: 'garden',
    kind: 'host-folder',
    hermesProjectId: 'p_garden',
    inference: { mode: 'inherit' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

/** Projects passed to the most recent overlay write. */
function lastOverlayProjects(): HermesProjectRecord[] {
  return writeOverlay.mock.calls.at(-1)?.[0] as HermesProjectRecord[];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-remounts-')));
  envRoot = dir('stack');
  resetHermesProjectsStoreForTests();
  resetCodingGrantStoreForTests();
  resetCodingRemountQueueForTests();
  recreate.mockReset().mockResolvedValue({ success: true });
  writeOverlay.mockReset();
  gatewayList.mockReset().mockResolvedValue({ projects: [], activeId: null });
});

afterEach(() => {
  setCodingGrantDepsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('folder remount queue (G09-9)', () => {
  it('runs one recreate at a time across project and coding remounts', async () => {
    let active = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const hold = async () => {
      active += 1;
      most = Math.max(most, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { success: true };
    };
    recreate.mockImplementation(hold);
    setCodingGrantDepsForTests({
      isLocalStack: () => false,
      writeOverlay: () => undefined,
      persistEnv: () => undefined,
      recreate: hold,
      verify: async () => true,
      progress: () => undefined,
      audit: () => undefined,
    });

    const all = Promise.all([
      syncOverlayAndRecreate(),
      syncOverlayAndRecreate(),
      scheduleCodingRemount(),
    ]);
    for (let done = 0; done < 3; done += 1) {
      await settle();
      expect(releases).toHaveLength(done + 1);
      releases[done]();
    }
    const outcomes = await all;
    expect(outcomes.every((outcome) => outcome.success)).toBe(true);
    expect(most).toBe(1);
  });

  it('writes the overlay when each remount starts, from the store as it is then', async () => {
    let release: () => void = () => undefined;
    recreate.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ success: true })))
    );
    const first = syncOverlayAndRecreate();
    await settle();
    upsertStoredHermesProject(hostProject());
    const second = syncOverlayAndRecreate();
    await settle();
    expect(writeOverlay).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(lastOverlayProjects().map((row) => row.id)).toEqual(['garden-id']);
  });
});

describe('a failed mount rolls back (G09-7)', () => {
  it('drops a new host-folder project and restores the active project', async () => {
    upsertStoredHermesProject(hostProject());
    setActiveHermesProjectId('garden-id');
    recreate.mockResolvedValue({ success: false, error: 'file sharing denied' });

    const result = await createHostFolderHermesProject({ hostPath: dir('notes') });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not share .*notes/);
    expect(listStoredHermesProjects().map((row) => row.id)).toEqual(['garden-id']);
    expect(getActiveHermesProjectId()).toBe('garden-id');
    expect(result.projects?.map((row) => row.id)).toEqual(['garden-id']);
    expect(lastOverlayProjects().map((row) => row.id)).toEqual(['garden-id']);
  });

  it('puts a moved project back in its old folder', async () => {
    upsertStoredHermesProject(hostProject({ codingEnabled: true }));
    // A fresh copy: the record handed to the store must not be what the check compares with.
    const before = hostProject({ codingEnabled: true });
    recreate.mockResolvedValue({ success: false, error: 'mount failed' });

    const result = await changeHermesProjectFolder({ projectId: 'garden-id', hostPath: dir('elsewhere') });

    expect(result.success).toBe(false);
    expect(listStoredHermesProjects()).toEqual([before]);
    expect(lastOverlayProjects()).toEqual([before]);
  });
});

describe('source folders write CONTEXT_EXTRA_ROOTS before the recreate (G09-6)', () => {
  it('has the new root in the stack .env when Hermes is recreated, and restores it on failure', async () => {
    upsertStoredHermesProject(hostProject());
    const reference = dir('reference');
    const seen: string[] = [];
    recreate.mockImplementation(async () => {
      seen.push(readAssistantEnvFile(envRoot).CONTEXT_EXTRA_ROOTS ?? '');
      return { success: true };
    });

    const added = await addHermesProjectSourceFolder('garden-id', reference);
    expect(added.success).toBe(true);
    expect(seen).toEqual([reference]);

    const second = dir('second');
    recreate.mockImplementation(async () => {
      seen.push(readAssistantEnvFile(envRoot).CONTEXT_EXTRA_ROOTS ?? '');
      return { success: false, error: 'mount failed' };
    });
    const failed = await addHermesProjectSourceFolder('garden-id', second);
    expect(failed.success).toBe(false);
    expect(seen[1].split(':').filter(Boolean).sort()).toEqual([reference, second].sort());
    expect(readAssistantEnvFile(envRoot).CONTEXT_EXTRA_ROOTS).toBe(reference);
  });
});

describe('a failed source mount leaves sources.yaml as it was', () => {
  it('deletes a sources.yaml the add created', async () => {
    const project = hostProject();
    upsertStoredHermesProject(project);
    recreate.mockResolvedValue({ success: false, error: 'mount failed' });

    const result = await addHermesProjectSourceFolder('garden-id', dir('reference'));

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(project.hostPath, SOURCES_NAME))).toBe(false);
    expect(result.inspect?.sources.map((row) => row.id)).toEqual(['project']);
  });

  it('keeps the sources listed before the add', async () => {
    const project = hostProject();
    upsertStoredHermesProject(project);
    const reference = dir('reference');
    expect((await addHermesProjectSourceFolder('garden-id', reference)).success).toBe(true);
    const before = fs.readFileSync(path.join(project.hostPath, SOURCES_NAME), 'utf8');
    recreate.mockResolvedValue({ success: false, error: 'mount failed' });

    const result = await addHermesProjectSourceFolder('garden-id', dir('second'));

    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(project.hostPath, SOURCES_NAME), 'utf8')).toBe(before);
    expect(readAssistantEnvFile(envRoot).CONTEXT_EXTRA_ROOTS).toBe(reference);
  });
});

describe('listHermesProjects (G09-17, G09-4)', () => {
  function libraryProject(): HermesProjectRecord {
    const dataRoot = resolveAssistantUserContentRoot(envRoot);
    return {
      id: 'notes-id',
      name: 'Notes',
      hostPath: path.join(dataRoot, 'projects', 'notes'),
      containerPath: '/opt/projects/notes',
      slug: 'notes',
      kind: 'empty',
      hermesProjectId: 'p_notes',
      inference: { mode: 'inherit' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    };
  }

  it('leaves the store and the overlay alone when the gateway lists what is stored', async () => {
    upsertStoredHermesProject(libraryProject());
    gatewayList.mockResolvedValue({
      projects: [{ id: 'p_notes', slug: 'notes', name: 'Notes', primaryPath: '/opt/projects/notes' }],
      activeId: null,
    });

    const result = await listHermesProjects();
    await settle();

    expect(result.rpcAvailable).toBe(true);
    expect(writeOverlay).not.toHaveBeenCalled();
    expect(listStoredHermesProjects()).toEqual([libraryProject()]);
  });

  it('does not report Hermes unreachable when writing the overlay fails', async () => {
    writeOverlay.mockImplementation(() => {
      throw new Error('EACCES');
    });
    gatewayList.mockResolvedValue({
      projects: [{ id: 'p_notes', slug: 'notes', name: 'Notes', primaryPath: '/opt/projects/notes' }],
      activeId: null,
    });

    const result = await listHermesProjects();
    await settle();

    expect(result.rpcAvailable).toBe(true);
    expect(result.projects?.map((row) => row.slug)).toEqual(['notes']);
    expect(writeOverlay).toHaveBeenCalledTimes(1);
  });
});
