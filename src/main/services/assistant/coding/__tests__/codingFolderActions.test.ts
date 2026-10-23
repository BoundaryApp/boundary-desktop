import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';

const addHermesProjectSourceFolder = vi.fn();
const removeHermesProjectSource = vi.fn();

vi.mock('../../hermes/hermesProjectSources', () => ({
  addHermesProjectSourceFolder: (...args: unknown[]) => addHermesProjectSourceFolder(...args),
  removeHermesProjectSource: (...args: unknown[]) => removeHermesProjectSource(...args),
}));

import {
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../../hermes/hermesProjectStore';
import { writeSourcesYamlToHub } from '../../hermes/projectSourcesModel';
import {
  deleteCodingFolder,
  deleteNeedsTypedName,
  inspectFolderForDelete,
  removeCodingFolder,
  walkFolder,
} from '../codingFolderActions';
import {
  resetCodingRemountQueueForTests,
  setCodingGrantDepsForTests,
  type CodingGrantDeps,
} from '../codingGrants';
import {
  addCodingGrantRecord,
  findCodingGrant,
  resetCodingGrantStoreForTests,
} from '../codingGrantStore';

let home: string;
let hub: string;

function folder(...parts: string[]): string {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface GitAnswers {
  status?: string;
  remote?: string;
  unpushed?: string;
  total?: string;
  diffTree?: string;
}

function fakeDeps(overrides: Partial<CodingGrantDeps> = {}, git: GitAnswers = {}) {
  const order: string[] = [];
  const deps: Partial<CodingGrantDeps> = {
    isLocalStack: () => false,
    busy: async () => ({ busy: false, sessions: [] }),
    writeOverlay: () => undefined,
    persistEnv: () => undefined,
    recreate: async () => {
      order.push('recreate');
      return { success: true };
    },
    verify: async () => true,
    restartHermes: async () => ({ success: true }),
    recordHermesRoots: () => undefined,
    ruleOptions: () => ({ home, boundaryDataPaths: [], systemFolders: [] }),
    runGit: async () => undefined,
    gitOutput: async (_cwd, args) => {
      if (args[0] === 'status') return git.status ?? '';
      if (args[0] === 'remote') return git.remote ?? 'origin';
      if (args[0] === 'rev-list' && args.includes('--not')) return git.unpushed ?? '0';
      if (args[0] === 'rev-list') return git.total ?? '5';
      if (args[0] === 'diff-tree') return git.diffTree ?? 'README.md';
      return '';
    },
    trash: async (hostPath) => {
      order.push(`trash:${hostPath}`);
    },
    progress: () => undefined,
    ...overrides,
  };
  setCodingGrantDepsForTests(deps);
  return order;
}

function grantRepo(name: string, createdByBoundary = false): string {
  const repo = folder('Code', name);
  folder('Code', name, '.git');
  fs.writeFileSync(path.join(repo, 'index.ts'), 'export {};');
  addCodingGrantRecord({ hostPath: repo, projectId: 'p1', origin: 'add', createdByBoundary });
  return repo;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-actions-')));
  hub = folder('Projects', 'portfolio');
  resetCodingGrantStoreForTests();
  resetHermesProjectsStoreForTests();
  resetCodingRemountQueueForTests();
  addHermesProjectSourceFolder.mockReset().mockResolvedValue({ success: true });
  removeHermesProjectSource.mockReset().mockResolvedValue({ success: true });
  const project: HermesProjectRecord = {
    id: 'p1',
    name: 'Portfolio',
    hostPath: hub,
    containerPath: '/opt/projects/portfolio',
    slug: 'portfolio',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  upsertStoredHermesProject(project);
});

afterEach(() => {
  setCodingGrantDepsForTests(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('walkFolder', () => {
  it('counts files and bytes, splits out node_modules, and skips symlinks', () => {
    const repo = folder('Code', 'site');
    fs.writeFileSync(path.join(repo, 'a.txt'), '12345');
    folder('Code', 'site', 'node_modules', 'pkg');
    fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), '123');
    fs.symlinkSync(home, path.join(repo, 'loop'));
    const walk = walkFolder(repo);
    expect(walk).toMatchObject({ files: 2, bytes: 8, nodeModulesBytes: 3, truncated: false });
    expect(walk.lastChangedMs).toBeGreaterThan(0);
  });

  it('stops at the cap and says so', () => {
    const repo = folder('Code', 'big');
    for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(repo, `f${i}`), 'x');
    expect(walkFolder(repo, 3).truncated).toBe(true);
  });
});

describe('deleteNeedsTypedName', () => {
  const clean = {
    createdByBoundary: true,
    isGit: true,
    dirtyCount: 0,
    unpushed: 0,
    onlyStartCommit: false,
  };
  it('is one click only for a clean, pushed folder Boundary created', () => {
    expect(deleteNeedsTypedName(clean)).toBe(false);
    expect(deleteNeedsTypedName({ ...clean, unpushed: 1, onlyStartCommit: true })).toBe(false);
  });

  it.each([
    ['not created by Boundary', { createdByBoundary: false }],
    ['not a git repo', { isGit: false }],
    ['uncommitted changes', { dirtyCount: 3 }],
    ['unpushed commits', { unpushed: 2 }],
  ])('asks for the name when %s', (_label, change) => {
    expect(deleteNeedsTypedName({ ...clean, ...change })).toBe(true);
  });
});

describe('inspectFolderForDelete', () => {
  it('reports what would be lost', async () => {
    fakeDeps({}, { status: ' M package.json\n?? notes.md', unpushed: '2' });
    const repo = grantRepo('contact-api');
    const facts = await inspectFolderForDelete(repo);
    expect(facts).toMatchObject({
      success: true,
      name: 'contact-api',
      isGit: true,
      hasRemote: true,
      unpushed: 2,
      dirtyCount: 2,
      dirtyFiles: ['package.json', 'notes.md'],
      createdByBoundary: false,
      requiresTypedName: true,
    });
  });

  it('refuses a folder that is not a grant, and a project’s own folder', async () => {
    fakeDeps();
    expect((await inspectFolderForDelete(folder('Code', 'loose'))).success).toBe(false);
    addCodingGrantRecord({
      hostPath: hub,
      projectId: 'p1',
      origin: 'add',
      createdByBoundary: false,
    });
    expect((await inspectFolderForDelete(hub)).error).toMatch(/project’s own folder/);
  });
});

describe('deleteCodingFolder', () => {
  it('needs the typed name when the review asked for it', async () => {
    const order = fakeDeps({}, { unpushed: '1' });
    const repo = grantRepo('contact-api');
    const res = await deleteCodingFolder({ hostPath: repo, confirmName: 'contact' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Type contact-api/);
    expect(order).toEqual([]);
    expect(findCodingGrant(repo)).not.toBeNull();
  });

  it('removes the grant, restarts the coding agent, then moves the folder to the Trash', async () => {
    const order = fakeDeps();
    const repo = grantRepo('contact-api');
    writeSourcesYamlToHub(hub, [
      { id: 'project', path: '.', retrieval: 'files', include: ['**/*.md'], exclude: [] },
      { id: 'contact-api', path: repo, retrieval: 'files', include: ['**/*.md'], exclude: [] },
    ]);
    const res = await deleteCodingFolder({ hostPath: repo, confirmName: 'contact-api' });
    expect(res.success).toBe(true);
    expect(res.trashed).toBe(true);
    expect(order).toEqual(['recreate', `trash:${repo}`]);
    expect(findCodingGrant(repo)).toBeNull();
    expect(removeHermesProjectSource).toHaveBeenCalledWith('p1', 'contact-api');
  });

  it('is one click for a clean folder Boundary created', async () => {
    fakeDeps();
    const repo = grantRepo('landing-page', true);
    expect((await deleteCodingFolder({ hostPath: repo })).trashed).toBe(true);
  });

  it('refuses while a coding task runs, before touching the grant', async () => {
    const order = fakeDeps({ busy: async () => ({ busy: true, sessions: ['x'] }) });
    const repo = grantRepo('landing-page', true);
    const res = await deleteCodingFolder({ hostPath: repo });
    expect(res.success).toBe(false);
    expect(res.busy?.busy).toBe(true);
    expect(order).toEqual([]);
    expect(findCodingGrant(repo)).not.toBeNull();
  });

  it('stops before the Trash when the restart fails', async () => {
    const order = fakeDeps({
      recreate: async () => {
        order.push('recreate');
        return { success: false, error: 'boom' };
      },
    });
    const repo = grantRepo('landing-page', true);
    const res = await deleteCodingFolder({ hostPath: repo });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/wasn’t moved/);
    expect(order).toEqual(['recreate']);
    expect(fs.existsSync(repo)).toBe(true);
  });
});

describe('removeCodingFolder', () => {
  it('keeps the folder as read-only reference by default', async () => {
    const order = fakeDeps();
    const repo = grantRepo('tokens');
    const res = await removeCodingFolder({ hostPath: repo, keep: 'reference' });
    expect(res.grants).toEqual([]);
    expect(order).toEqual(['recreate']);
    expect(addHermesProjectSourceFolder).toHaveBeenCalledWith('p1', repo);
    expect(fs.existsSync(repo)).toBe(true);
  });

  it('drops it from the project when asked', async () => {
    fakeDeps();
    const repo = grantRepo('tokens');
    writeSourcesYamlToHub(hub, [
      { id: 'project', path: '.', retrieval: 'files', include: ['**/*.md'], exclude: [] },
      { id: 'tokens', path: repo, retrieval: 'files', include: ['**/*.md'], exclude: [] },
    ]);
    await removeCodingFolder({ hostPath: repo, keep: 'none' });
    expect(removeHermesProjectSource).toHaveBeenCalledWith('p1', 'tokens');
    expect(addHermesProjectSourceFolder).not.toHaveBeenCalled();
    expect(fs.existsSync(repo)).toBe(true);
  });
});
