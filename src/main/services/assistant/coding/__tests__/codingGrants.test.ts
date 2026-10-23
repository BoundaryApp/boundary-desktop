import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import {
  resetHermesProjectsStoreForTests,
  upsertStoredHermesProject,
} from '../../hermes/hermesProjectStore';
import {
  checkNewCodingFolder,
  createCodingFolder,
  grantCoding,
  newCodingFolderDefaults,
  listCodingGrants,
  resetCodingRemountQueueForTests,
  revokeCoding,
  scheduleCodingRemount,
  setCodingGrantDepsForTests,
  setProjectFolderCoding,
  type CodingGrantDeps,
} from '../codingGrants';
import { recordHermesCodingRoots, resetCodingGrantStoreForTests } from '../codingGrantStore';

let home: string;

function project(partial: Partial<HermesProjectRecord> = {}): HermesProjectRecord {
  return {
    id: 'p1',
    name: 'Portfolio',
    hostPath: path.join(home, 'Projects', 'portfolio'),
    containerPath: '/opt/projects/portfolio',
    slug: 'portfolio',
    kind: 'host-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function folder(...parts: string[]): string {
  const dir = path.join(home, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeDeps(overrides: Partial<CodingGrantDeps> = {}) {
  const calls = {
    recreate: 0,
    persisted: [] as string[][],
    verified: [] as string[],
    git: [] as string[][],
  };
  const deps: Partial<CodingGrantDeps> = {
    isLocalStack: () => false,
    busy: async () => ({ busy: false, sessions: [] }),
    writeOverlay: () => undefined,
    persistEnv: (roots) => {
      calls.persisted.push([...roots]);
    },
    recreate: async () => {
      calls.recreate += 1;
      return { success: true };
    },
    verify: async (hostPath) => {
      calls.verified.push(hostPath);
      return true;
    },
    restartHermes: async () => ({ success: true }),
    recordHermesRoots: () => undefined,
    ruleOptions: () => ({ home, boundaryDataPaths: [path.join(home, 'boundary')], systemFolders: [] }),
    runGit: async (_cwd, args) => {
      calls.git.push(args);
    },
    progress: () => undefined,
    ...overrides,
  };
  setCodingGrantDepsForTests(deps);
  return calls;
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'coding-home-')));
  resetCodingGrantStoreForTests();
  resetHermesProjectsStoreForTests();
  resetCodingRemountQueueForTests();
  upsertStoredHermesProject(project());
  folder('Projects', 'portfolio');
});

afterEach(() => {
  setCodingGrantDepsForTests(null);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('grantCoding', () => {
  it('records the grant, restarts the coding agent once, verifies it, and persists the roots', async () => {
    const calls = fakeDeps();
    const repo = folder('Code', 'design-tokens');
    const res = await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    expect(res.success).toBe(true);
    expect(res.grants).toHaveLength(1);
    expect(res.grants[0]).toMatchObject({
      capability: 'coding',
      resource: repo,
      expiresAt: null,
      projectId: 'p1',
      origin: 'add',
      createdByBoundary: false,
      state: 'ready',
      hermesPending: true,
    });
    expect(calls.recreate).toBe(1);
    expect(calls.verified).toEqual([repo]);
    expect(calls.persisted).toEqual([[repo]]);
  });

  it('refuses a folder the rules refuse, without touching anything', async () => {
    const calls = fakeDeps();
    const res = await grantCoding({ projectId: 'p1', hostPath: home, origin: 'add' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/home folder/);
    expect(res.grants).toEqual([]);
    expect(calls.recreate).toBe(0);
  });

  it('stops and reports a running coding task unless told to stop it', async () => {
    const calls = fakeDeps({ busy: async () => ({ busy: true, sessions: ['Fix header layout'] }) });
    const repo = folder('Code', 'a');
    const blocked = await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    expect(blocked.success).toBe(false);
    expect(blocked.busy).toEqual({ busy: true, sessions: ['Fix header layout'] });
    expect(blocked.grants).toEqual([]);
    expect(calls.recreate).toBe(0);

    const forced = await grantCoding({
      projectId: 'p1',
      hostPath: repo,
      origin: 'add',
      stopRunningTask: true,
    });
    expect(forced.success).toBe(true);
    expect(calls.recreate).toBe(1);
  });

  it('needs no restart for a folder inside an existing grant', async () => {
    const calls = fakeDeps();
    const parent = folder('Code', 'mono');
    const child = folder('Code', 'mono', 'packages', 'web');
    await grantCoding({ projectId: 'p1', hostPath: parent, origin: 'add' });
    const res = await grantCoding({ projectId: 'p1', hostPath: child, origin: 'chat' });
    expect(res.success).toBe(true);
    expect(calls.recreate).toBe(1);
    expect(res.grants.map((grant) => grant.resource)).toEqual([parent, child]);
  });

  it('keeps the grant as not visible when the coding agent cannot open it', async () => {
    fakeDeps({ verify: async () => false });
    const repo = folder('Code', 'external');
    const res = await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/can’t open/);
    expect(res.grants[0].state).toBe('not-visible');
  });

  it('marks every root not visible when the restart fails', async () => {
    fakeDeps({ recreate: async () => ({ success: false, error: 'compose exploded' }) });
    const repo = folder('Code', 'a');
    const res = await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('compose exploded');
    expect(res.grants[0].state).toBe('not-visible');
  });

  it('clears the Hermes wait once Hermes has started with the root', async () => {
    fakeDeps();
    const repo = folder('Code', 'a');
    await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    recordHermesCodingRoots([repo]);
    expect(listCodingGrants().grants[0].hermesPending).toBe(false);
  });

  it('is not managed in local-stack mode', async () => {
    fakeDeps({ isLocalStack: () => true });
    const res = await grantCoding({ projectId: 'p1', hostPath: folder('Code', 'a'), origin: 'add' });
    expect(res).toMatchObject({ success: false, managed: false });
    expect(res.command).toMatch(/make coding-root-add/);
  });
});

describe('scheduleCodingRemount', () => {
  it('lets callers that arrive while a remount waits share its restart', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recreates = 0;
    fakeDeps({
      recreate: async () => {
        recreates += 1;
        await gate;
        return { success: true };
      },
    });
    const first = scheduleCodingRemount();
    await Promise.resolve();
    await Promise.resolve();
    const second = scheduleCodingRemount();
    const third = scheduleCodingRemount();
    expect(second).toBe(third);
    release();
    await Promise.all([first, second, third]);
    expect(recreates).toBe(2);
  });
});

describe('setProjectFolderCoding', () => {
  it('turns coding on for a host-folder project and lists it as a project-folder grant', async () => {
    const calls = fakeDeps();
    const res = await setProjectFolderCoding({ projectId: 'p1', enabled: true });
    expect(res.success).toBe(true);
    expect(res.grants[0]).toMatchObject({
      origin: 'project-folder',
      resource: path.join(home, 'Projects', 'portfolio'),
      hermesPending: false,
    });
    expect(calls.recreate).toBe(1);

    const off = await setProjectFolderCoding({ projectId: 'p1', enabled: false });
    expect(off.grants).toEqual([]);
    expect(calls.recreate).toBe(2);
  });

  it('refuses a project without a host folder', async () => {
    fakeDeps();
    upsertStoredHermesProject(project({ id: 'p2', kind: 'empty' }));
    const res = await setProjectFolderCoding({ projectId: 'p2', enabled: true });
    expect(res.success).toBe(false);
  });
});

describe('revokeCoding', () => {
  it('removes the grant and restarts the coding agent', async () => {
    const calls = fakeDeps();
    const repo = folder('Code', 'a');
    await grantCoding({ projectId: 'p1', hostPath: repo, origin: 'add' });
    const res = await revokeCoding({ hostPath: repo });
    expect(res.success).toBe(true);
    expect(res.grants).toEqual([]);
    expect(calls.recreate).toBe(2);
    expect(calls.persisted.at(-1)).toEqual([]);
  });
});

describe('createCodingFolder', () => {
  it('creates an empty folder, starts a git repo with a first commit, and grants it', async () => {
    const calls = fakeDeps();
    const parent = folder('Code');
    const res = await createCodingFolder({
      projectId: 'p1',
      parent,
      name: 'landing-page',
      initGit: true,
    });
    const created = path.join(parent, 'landing-page');
    expect(res.success).toBe(true);
    expect(res.hostPath).toBe(created);
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(calls.git).toEqual([['init'], ['commit', '--allow-empty', '-m', 'Start']]);
    expect(res.grants[0]).toMatchObject({
      resource: created,
      origin: 'new-folder',
      createdByBoundary: true,
    });
  });

  it('retries the first commit as Boundary when git has no identity', async () => {
    const git: string[][] = [];
    fakeDeps({
      runGit: async (_cwd, args) => {
        git.push(args);
        if (args[0] === 'commit') throw new Error('Please tell me who you are');
      },
    });
    const res = await createCodingFolder({ projectId: 'p1', parent: folder('Code'), name: 'x', initGit: true });
    expect(res.success).toBe(true);
    expect(git.at(-1)).toEqual([
      '-c',
      'user.name=Boundary',
      '-c',
      'user.email=boundary@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'Start',
    ]);
  });

  it('never creates over an existing folder', async () => {
    const calls = fakeDeps();
    const parent = folder('Code');
    folder('Code', 'design-tokens');
    const res = await createCodingFolder({
      projectId: 'p1',
      parent,
      name: 'design-tokens',
      initGit: true,
    });
    expect(res).toMatchObject({ success: false, exists: true });
    expect(calls.git).toEqual([]);
    expect(res.grants).toEqual([]);
  });

  it.each(['a/b', 'a:b', '..', '.hidden', ''])('refuses the name %j', async (name) => {
    fakeDeps();
    const res = await createCodingFolder({ projectId: 'p1', parent: folder('Code'), name, initGit: false });
    expect(res.success).toBe(false);
  });

  it('refuses a parent the rules refuse, but allows home itself as the parent', async () => {
    fakeDeps();
    const refused = await createCodingFolder({
      projectId: 'p1',
      parent: folder('boundary'),
      name: 'x',
      initGit: false,
    });
    expect(refused.success).toBe(false);
    const inHome = await createCodingFolder({ projectId: 'p1', parent: home, name: 'new-repo', initGit: false });
    expect(inHome.success).toBe(true);
  });

  it('does not create missing parents', async () => {
    fakeDeps();
    const res = await createCodingFolder({
      projectId: 'p1',
      parent: path.join(home, 'nope'),
      name: 'x',
      initGit: false,
    });
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(home, 'nope'))).toBe(false);
  });
});

describe('listCodingGrants', () => {
  it('returns an empty managed list by default', () => {
    fakeDeps();
    expect(listCodingGrants()).toEqual({ success: true, managed: true, grants: [] });
  });
});

describe('checkNewCodingFolder', () => {
  it('reports the path a valid name would create', () => {
    fakeDeps();
    const parent = folder('Code');
    expect(checkNewCodingFolder({ parent, name: ' landing-page ' })).toEqual({
      success: true,
      hostPath: path.join(parent, 'landing-page'),
      exists: false,
    });
  });

  it('describes a taken name: a git repo and how many items it holds', () => {
    fakeDeps();
    const parent = folder('Code');
    const repo = folder('Code', 'design-tokens');
    folder('Code', 'design-tokens', '.git');
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    expect(checkNewCodingFolder({ parent, name: 'design-tokens' })).toEqual({
      success: true,
      hostPath: repo,
      exists: true,
      isDirectory: true,
      isGit: true,
      entries: 2,
    });
  });

  it('flags a file with that name as not a folder', () => {
    fakeDeps();
    const parent = folder('Code');
    fs.writeFileSync(path.join(parent, 'notes'), 'x');
    expect(checkNewCodingFolder({ parent, name: 'notes' })).toMatchObject({
      exists: true,
      isDirectory: false,
    });
  });

  it('explains a bad name, a missing parent and a refused parent', () => {
    fakeDeps();
    expect(checkNewCodingFolder({ parent: folder('Code'), name: '' }).error).toMatch(/name/);
    expect(checkNewCodingFolder({ parent: path.join(home, 'nope'), name: 'x' }).error).toMatch(
      /doesn’t exist/
    );
    expect(checkNewCodingFolder({ parent: folder('boundary'), name: 'x' }).error).toMatch(
      /Boundary’s own data/
    );
    expect(checkNewCodingFolder({ parent: home, name: 'x' }).success).toBe(true);
  });
});

describe('newCodingFolderDefaults', () => {
  it('starts in the parent of the most recent grant', async () => {
    fakeDeps({ gitAvailable: async () => true });
    await grantCoding({ projectId: 'p1', hostPath: folder('Work', 'older'), origin: 'add' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await grantCoding({ projectId: 'p1', hostPath: folder('Repos', 'newer'), origin: 'add' });
    expect(await newCodingFolderDefaults()).toEqual({
      defaultParent: path.join(home, 'Repos'),
      gitAvailable: true,
      managed: true,
    });
  });

  it('falls back to ~/Code, then home, and reports missing git', async () => {
    fakeDeps({ gitAvailable: async () => false });
    expect((await newCodingFolderDefaults()).defaultParent).toBe(home);
    folder('Code');
    expect(await newCodingFolderDefaults()).toEqual({
      defaultParent: path.join(home, 'Code'),
      gitAvailable: false,
      managed: true,
    });
  });
});

describe('createCodingFolder for reference', () => {
  it('creates the folder without a grant or a restart, even on a developer stack', async () => {
    const calls = fakeDeps({ isLocalStack: () => true });
    const parent = folder('Notes');
    const res = await createCodingFolder({
      projectId: 'p1',
      parent,
      name: 'research',
      initGit: false,
      grant: false,
    });
    expect(res.hostPath).toBe(path.join(parent, 'research'));
    expect(fs.statSync(path.join(parent, 'research')).isDirectory()).toBe(true);
    expect(calls.recreate).toBe(0);
    expect(res.grants).toEqual([]);
  });
});
