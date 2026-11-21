import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';

const recreate = vi.fn();
const writeOverlay = vi.fn();
const ensureConnected = vi.fn();
const setActiveProject = vi.fn();
const deleteProject = vi.fn();
const runningTurns = vi.fn();
const trash = vi.fn();
let envRoot = '';
let hostFolders = true;

vi.mock('../../../stackHost/capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../stackHost/capabilities')>()),
  hasStackCapability: (capability: string) => capability !== 'hostFolders' || hostFolders,
  stackCapabilityRefusal: (capability: string) =>
    capability === 'hostFolders' && !hostFolders ? 'missing hostFolders' : null,
}));

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: () => ensureConnected(),
    setActiveProject: (id: string | null) => setActiveProject(id),
    deleteProject: (id: string) => deleteProject(id),
    listProjects: vi.fn().mockResolvedValue({ projects: [], activeId: null }),
  }),
}));

vi.mock('../hermesRunningTurns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesRunningTurns')>()),
  listRunningTurns: () => runningTurns(),
}));

vi.mock('../hermesChatProjects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesChatProjects')>()),
  conversationProjectId: (id: string) => (id === 'garden-chat' ? 'garden-id' : null),
}));

vi.mock('../../AssistantStackService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../AssistantStackService')>()),
  recreateHermesForProjectMounts: (...args: unknown[]) => recreate(...args),
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

import { resolveAssistantUserContentRoot } from '../../assistantPaths';
import { readEnvFile } from '../../stackEnv';
import { resetCodingGrantStoreForTests } from '../../coding/codingGrantStore';
import { fakeCodingDeps, makeFolder, resetCodingDepsForTests, type CodingDepCalls } from '../../coding/__tests__/codingDeps';
import {
  inspectHermesProjectForRemove,
  REMOTE_HOST_REFUSAL,
  removeHermesProject,
  setProjectRemoveDepsForTests,
} from '../hermesProjectRemove';
import { SOURCES_NAME, serializeSourcesYaml } from '../projectSourcesModel';
import {
  getActiveHermesProjectId,
  listStoredHermesProjects,
  resetHermesProjectsStoreForTests,
  setActiveHermesProjectId,
  upsertStoredHermesProject,
} from '../hermesProjectStore';

let tmp: string;
let coding: CodingDepCalls;

function dir(...parts: string[]): string {
  return makeFolder(tmp, ...parts);
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

function placeholder(slug = 'garden'): string {
  return path.join(resolveAssistantUserContentRoot(envRoot), 'projects', slug);
}

function lastOverlayProjects(): HermesProjectRecord[] {
  return writeOverlay.mock.calls.at(-1)?.[0] as HermesProjectRecord[];
}

/** A sources.yaml listing the project folder and one extra folder. */
function sourcesListing(extra: string): string {
  const spec = { retrieval: 'files' as const, include: [] as string[], exclude: [] as string[] };
  return serializeSourcesYaml([
    { id: 'project', path: '.', ...spec },
    { id: 'ref', path: extra, ...spec },
  ]);
}

function envFile(): string {
  return path.join(envRoot, '.env');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-remove-')));
  envRoot = dir('stack');
  resetHermesProjectsStoreForTests();
  resetCodingGrantStoreForTests();
  coding = fakeCodingDeps({ home: tmp });
  recreate.mockReset().mockResolvedValue({ success: true });
  writeOverlay.mockReset();
  ensureConnected.mockReset().mockResolvedValue(undefined);
  setActiveProject.mockReset().mockResolvedValue(undefined);
  deleteProject.mockReset().mockResolvedValue(undefined);
  runningTurns.mockReset().mockReturnValue([]);
  trash.mockReset().mockResolvedValue(undefined);
  setProjectRemoveDepsForTests({ trash });
  hostFolders = true;
});

afterEach(() => {
  resetCodingDepsForTests();
  setProjectRemoveDepsForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('removing a folder project (ADR 0067 §2)', () => {
  it('removes the record, rewrites the overlay without the bind and recreates Hermes', async () => {
    upsertStoredHermesProject(hostProject());
    setActiveHermesProjectId('garden-id');

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);
    expect(listStoredHermesProjects()).toEqual([]);
    expect(getActiveHermesProjectId()).toBeNull();
    expect(lastOverlayProjects()).toEqual([]);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(result.projects).toEqual([]);
    expect(result.activeId).toBeNull();
  });

  it('clears the gateway’s active project and deletes its row', async () => {
    upsertStoredHermesProject(hostProject());
    setActiveHermesProjectId('garden-id');

    await removeHermesProject({ projectId: 'garden-id' });

    expect(setActiveProject).toHaveBeenCalledWith(null);
    expect(deleteProject).toHaveBeenCalledWith('p_garden');
  });

  it('keeps another active project, on the gateway too', async () => {
    upsertStoredHermesProject(hostProject());
    upsertStoredHermesProject(hostProject({ id: 'notes-id', slug: 'notes', hostPath: dir('notes') }));
    setActiveHermesProjectId('notes-id');

    await removeHermesProject({ projectId: 'garden-id' });

    expect(getActiveHermesProjectId()).toBe('notes-id');
    expect(setActiveProject).not.toHaveBeenCalled();
  });

  it('skips projects.delete for an fs: id', async () => {
    upsertStoredHermesProject(hostProject({ hermesProjectId: 'fs:/opt/projects/garden' }));

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it('still succeeds when projects.delete throws', async () => {
    upsertStoredHermesProject(hostProject());
    deleteProject.mockRejectedValue(new Error('gateway gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[projects] remove:'), 'gateway gone');
    warn.mockRestore();
  });

  it('drops the project’s extra source folders from CONTEXT_EXTRA_ROOTS', async () => {
    const project = hostProject();
    upsertStoredHermesProject(project);
    const reference = dir('reference');
    const sources = sourcesListing(reference);
    fs.writeFileSync(path.join(project.hostPath, SOURCES_NAME), sources);
    fs.writeFileSync(envFile(), `CONTEXT_EXTRA_ROOTS=${reference}\n`);

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(readEnvFile(envFile()).CONTEXT_EXTRA_ROOTS ?? '').not.toContain(reference);
    expect(fs.readFileSync(path.join(project.hostPath, SOURCES_NAME), 'utf8')).toBe(sources);
  });

  it('keeps an extra source folder another project still lists', async () => {
    const project = hostProject();
    const other = hostProject({
      id: 'site-id',
      name: 'Site',
      hostPath: dir('site'),
      containerPath: '/opt/projects/site',
      slug: 'site',
      hermesProjectId: 'p_site',
    });
    upsertStoredHermesProject(project);
    upsertStoredHermesProject(other);
    const reference = dir('reference');
    fs.writeFileSync(path.join(project.hostPath, SOURCES_NAME), sourcesListing(reference));
    fs.writeFileSync(path.join(other.hostPath, SOURCES_NAME), sourcesListing(reference));
    fs.writeFileSync(envFile(), `CONTEXT_EXTRA_ROOTS=${reference}\n`);

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(readEnvFile(envFile()).CONTEXT_EXTRA_ROOTS).toBe(reference);
  });

  it('deletes a placeholder that holds only Finder files', async () => {
    upsertStoredHermesProject(hostProject());
    fs.mkdirSync(placeholder(), { recursive: true });
    fs.writeFileSync(path.join(placeholder(), '.DS_Store'), 'x');
    fs.writeFileSync(path.join(placeholder(), '._notes'), 'x');

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(fs.existsSync(placeholder())).toBe(false);
  });

  it('deletes an empty placeholder', async () => {
    upsertStoredHermesProject(hostProject());
    fs.mkdirSync(placeholder(), { recursive: true });

    await removeHermesProject({ projectId: 'garden-id' });

    expect(fs.existsSync(placeholder())).toBe(false);
  });

  it('keeps a placeholder that isn’t empty and logs it', async () => {
    upsertStoredHermesProject(hostProject());
    fs.mkdirSync(placeholder(), { recursive: true });
    fs.writeFileSync(path.join(placeholder(), 'stray.txt'), 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(placeholder(), 'stray.txt'))).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('placeholder not empty, left garden'));
    warn.mockRestore();
  });

  it('rolls back when the recreate fails', async () => {
    const project = hostProject();
    upsertStoredHermesProject(project);
    setActiveHermesProjectId('garden-id');
    const reference = dir('reference');
    fs.writeFileSync(path.join(project.hostPath, SOURCES_NAME), sourcesListing(reference));
    fs.writeFileSync(envFile(), `CONTEXT_EXTRA_ROOTS=${reference}\n`);
    fs.mkdirSync(placeholder(), { recursive: true });
    recreate.mockResolvedValue({ success: false, error: 'boom' });

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(false);
    expect(result.removed).toBeFalsy();
    expect(listStoredHermesProjects()).toEqual([hostProject()]);
    expect(getActiveHermesProjectId()).toBe('garden-id');
    expect(readEnvFile(envFile()).CONTEXT_EXTRA_ROOTS).toBe(reference);
    expect(fs.existsSync(placeholder())).toBe(true);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(setActiveProject).not.toHaveBeenCalled();
  });

  it('refuses while a coding task runs, and removes nothing', async () => {
    upsertStoredHermesProject(hostProject({ codingEnabled: true }));
    const busy = { busy: true, sessions: ['Fix tests'] };
    resetCodingDepsForTests();
    coding = fakeCodingDeps({ home: tmp, overrides: { busy: async () => busy } });

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(false);
    expect(result.busy).toEqual(busy);
    expect(listStoredHermesProjects()).toHaveLength(1);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('turns coding off in the same restart, and audits it', async () => {
    upsertStoredHermesProject(hostProject({ codingEnabled: true }));
    resetCodingDepsForTests();
    coding = fakeCodingDeps({
      home: tmp,
      overrides: { busy: async () => ({ busy: true, sessions: [] }) },
    });

    const result = await removeHermesProject({ projectId: 'garden-id', stopRunningTask: true });

    expect(result.success).toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(recreate.mock.calls[0][0]).toMatchObject({ codingAgent: true });
    expect(coding.audit).toEqual([
      expect.objectContaining({
        tool: 'coding_revoke',
        args: { path: hostProject().hostPath, projectId: 'garden-id' },
        outcome: 'removed',
      }),
    ]);
  });

  it('refuses while a reply in the project is running', async () => {
    upsertStoredHermesProject(hostProject());
    runningTurns.mockReturnValue([{ sessionIds: ['garden-chat'] }]);

    const result = await removeHermesProject({ projectId: 'garden-id' });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'A reply in this project is still running. Remove it when the reply finishes.'
    );
    expect(listStoredHermesProjects()).toHaveLength(1);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('refuses a project it doesn’t know', async () => {
    const result = await removeHermesProject({ projectId: 'missing' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Project not found.');
  });

  it('leaves the folder itself alone', async () => {
    const project = hostProject();
    upsertStoredHermesProject(project);
    fs.writeFileSync(path.join(project.hostPath, 'notes.md'), 'keep me');

    await removeHermesProject({ projectId: 'garden-id' });

    expect(fs.readFileSync(path.join(project.hostPath, 'notes.md'), 'utf8')).toBe('keep me');
  });
});


describe('removing a Boundary-made project (ADR 0067 §3)', () => {
  function madeProject(partial: Partial<HermesProjectRecord> = {}): HermesProjectRecord {
    const hostPath = placeholder('sketches');
    fs.mkdirSync(hostPath, { recursive: true });
    return hostProject({
      id: 'sketches-id',
      name: 'Sketches',
      hostPath,
      containerPath: '/opt/projects/sketches',
      slug: 'sketches',
      kind: 'empty',
      hermesProjectId: 'p_sketches',
      ...partial,
    });
  }

  it('moves the folder to the Trash, then removes the record without a recreate', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    setActiveHermesProjectId(project.id);
    fs.writeFileSync(path.join(project.hostPath, 'idea.md'), 'x');

    const result = await removeHermesProject({ projectId: project.id, confirmName: 'Sketches' });

    expect(result.success).toBe(true);
    expect(result.trashed).toBe(true);
    expect(result.removed).toBe(true);
    expect(trash).toHaveBeenCalledWith(project.hostPath);
    expect(listStoredHermesProjects()).toEqual([]);
    expect(getActiveHermesProjectId()).toBeNull();
    expect(recreate).not.toHaveBeenCalled();
    expect(setActiveProject).toHaveBeenCalledWith(null);
    expect(deleteProject).toHaveBeenCalledWith('p_sketches');
  });

  it('changes nothing when the Trash move fails', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    setActiveHermesProjectId(project.id);
    trash.mockRejectedValue(new Error('locked'));

    const result = await removeHermesProject({ projectId: project.id, confirmName: 'Sketches' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('locked');
    expect(listStoredHermesProjects()).toEqual([project]);
    expect(getActiveHermesProjectId()).toBe(project.id);
    expect(deleteProject).not.toHaveBeenCalled();
    expect(setActiveProject).not.toHaveBeenCalled();
  });

  it('asks for the typed name under the coding-folder rule', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    fs.writeFileSync(path.join(project.hostPath, 'idea.md'), 'x');

    const inspect = await inspectHermesProjectForRemove(project.id);
    expect(inspect.requiresTypedName).toBe(true);

    const refused = await removeHermesProject({ projectId: project.id });
    expect(refused.success).toBe(false);
    expect(refused.error).toBe('Type Sketches to confirm.');
    expect(trash).not.toHaveBeenCalled();

    const wrong = await removeHermesProject({ projectId: project.id, confirmName: 'sketch' });
    expect(wrong.success).toBe(false);
    expect(trash).not.toHaveBeenCalled();
  });

  it('inspect reports files, size and git facts', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    fs.writeFileSync(path.join(project.hostPath, 'a.txt'), 'abc');
    fs.writeFileSync(path.join(project.hostPath, 'b.txt'), 'abcde');

    const inspect = await inspectHermesProjectForRemove(project.id);

    expect(inspect).toMatchObject({
      success: true,
      projectId: project.id,
      name: 'Sketches',
      kind: 'empty',
      hostPath: project.hostPath,
      files: 2,
      bytes: 8,
      isGit: false,
      truncated: false,
    });
    expect(inspect.lastChanged).toEqual(expect.any(String));
    expect(inspect.refusal).toBeUndefined();
  });

  it('inspect of a folder project skips the walk and the typed name', async () => {
    upsertStoredHermesProject(hostProject());
    fs.writeFileSync(path.join(hostProject().hostPath, 'a.txt'), 'abc');

    const inspect = await inspectHermesProjectForRemove('garden-id');

    expect(inspect).toMatchObject({ success: true, kind: 'host-folder', requiresTypedName: false });
    expect(inspect.files).toBeUndefined();
  });

  it('inspect carries the running-reply refusal', async () => {
    upsertStoredHermesProject(hostProject());
    runningTurns.mockReturnValue([{ sessionIds: ['garden-chat'] }]);

    const inspect = await inspectHermesProjectForRemove('garden-id');

    expect(inspect.refusal).toBe(
      'A reply in this project is still running. Remove it when the reply finishes.'
    );
  });

  it('forgets a project whose folder is already gone', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    fs.rmSync(project.hostPath, { recursive: true, force: true });
    trash.mockRejectedValue(new Error('no such file'));

    expect((await inspectHermesProjectForRemove(project.id)).requiresTypedName).toBe(false);
    const result = await removeHermesProject({ projectId: project.id, confirmName: 'Sketches' });

    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);
    expect(trash).not.toHaveBeenCalled();
    expect(listStoredHermesProjects()).toEqual([]);
  });

  it('works with the gateway down', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    setActiveHermesProjectId(project.id);
    ensureConnected.mockRejectedValue(new Error('stack stopped'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await removeHermesProject({ projectId: project.id, confirmName: 'Sketches' });

    expect(result.success).toBe(true);
    expect(result.trashed).toBe(true);
    expect(listStoredHermesProjects()).toEqual([]);
    expect(getActiveHermesProjectId()).toBeNull();
    warn.mockRestore();
  });

  it('is refused on a remote stack host', async () => {
    const project = madeProject();
    upsertStoredHermesProject(project);
    hostFolders = false;

    const inspect = await inspectHermesProjectForRemove(project.id);
    const result = await removeHermesProject({ projectId: project.id, confirmName: 'Sketches' });

    expect(inspect.refusal).toBe(REMOTE_HOST_REFUSAL);
    expect(result.success).toBe(false);
    expect(result.error).toBe(REMOTE_HOST_REFUSAL);
    expect(trash).not.toHaveBeenCalled();
    expect(listStoredHermesProjects()).toEqual([project]);
  });
});
