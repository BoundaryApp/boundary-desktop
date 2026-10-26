import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const HOME = '/Users/ada';
const stage = vi.fn();
const applyProjects = vi.fn();

vi.mock('../../assistant/coding/codingGrants', () => ({
  codingGrantDeps: () => ({
    ruleOptions: () => ({
      home: HOME,
      boundaryDataPaths: [path.join(os.tmpdir(), 'boundary-userdata')],
      isDirectory: () => true,
      realpath: (candidate: string) => candidate,
    }),
  }),
}));

vi.mock('../../assistant/hermes/hermesProjects', () => ({
  stageHostFolderHermesProjects: (...args: unknown[]) => stage(...args),
  applyFirstRunHermesProjects: (...args: unknown[]) => applyProjects(...args),
}));

import {
  getSetupProgress,
  recordOptionalStepOutcome,
  recordSetupHistoryOnce,
  resetSetupProgressStoreForTests,
} from '../SetupProgressStore';
import { applyFirstRunFolders, judgeFirstRunFolder, saveFirstRunFolders } from '../firstRunFolders';

describe('setup progress store (first-run spec, Phase 1)', () => {
  beforeEach(() => {
    resetSetupProgressStoreForTests();
  });

  it('marks a user who finished setup before the upgrade, once', () => {
    recordSetupHistoryOnce({ setupComplete: true, hasProjects: false });
    // A later launch with different facts doesn't rewrite it.
    recordSetupHistoryOnce({ setupComplete: false, hasProjects: true });
    expect(getSetupProgress()).toMatchObject({
      completedBeforeOptionalSteps: true,
      hadProjectsBeforeOptionalSteps: false,
    });
  });

  it('never marks a new user as upgraded when they finish setup later', () => {
    recordSetupHistoryOnce({ setupComplete: false, hasProjects: false });
    recordSetupHistoryOnce({ setupComplete: true, hasProjects: true });
    expect(getSetupProgress().completedBeforeOptionalSteps).toBe(false);
  });

  it('keeps a skip across a relaunch', async () => {
    recordOptionalStepOutcome('folders', 'skipped');
    vi.resetModules();
    const relaunched = await import('../SetupProgressStore');
    expect(relaunched.getSetupProgress().outcomes).toEqual({ folders: 'skipped' });
  });
});

describe('Folders step picks (first-run spec, Phase 2)', () => {
  beforeEach(() => {
    resetSetupProgressStoreForTests();
    stage.mockReset();
    applyProjects.mockReset();
  });

  it.each([
    ['/', 'whole disk'],
    [HOME, 'home folder is too broad'],
    ['/Users', 'contains your home folder'],
    ['/System/Library', 'System and Library'],
    [`${HOME}/Library/Mail`, 'System and Library'],
  ])('refuses %s with the reason', (hostPath, reason) => {
    expect(judgeFirstRunFolder(hostPath).refuseMessage).toContain(reason);
    const saved = saveFirstRunFolders([{ kind: 'host-folder', hostPath }]);
    expect(saved.success).toBe(false);
    expect(stage).not.toHaveBeenCalled();
    expect(getSetupProgress().pendingFolders).toEqual([]);
    expect(getSetupProgress().outcomes).toEqual({});
  });

  it('shows a folder under home by its ~/ path', () => {
    expect(judgeFirstRunFolder(`${os.homedir()}/Code/garden`)).toMatchObject({
      name: 'garden',
      displayPath: '~/Code/garden',
      refuseMessage: null,
    });
  });

  it('saves the picks in order, stages the folders and records the step as done', () => {
    const saved = saveFirstRunFolders([
      { kind: 'host-folder', hostPath: `${HOME}/Code/garden` },
      { kind: 'empty', name: '  Trip planning ' },
      { kind: 'host-folder', hostPath: `${HOME}/Code/garden` },
      { kind: 'host-folder', hostPath: `${HOME}/notes` },
    ]);
    expect(saved.success).toBe(true);
    expect(saved.progress.outcomes).toEqual({ folders: 'done' });
    expect(saved.progress.pendingFolders).toEqual([
      { kind: 'host-folder', hostPath: `${HOME}/Code/garden` },
      { kind: 'empty', name: 'Trip planning' },
      { kind: 'host-folder', hostPath: `${HOME}/notes` },
    ]);
    expect(stage).toHaveBeenCalledWith([`${HOME}/Code/garden`, `${HOME}/notes`]);
  });

  it('refuses an empty save', () => {
    expect(saveFirstRunFolders([]).success).toBe(false);
  });

  it('clears the picks after applying, even when creating a project fails', async () => {
    saveFirstRunFolders([{ kind: 'host-folder', hostPath: `${HOME}/notes` }]);
    applyProjects.mockResolvedValue({ success: false, error: 'mount failed', activeId: null });
    const applied = await applyFirstRunFolders();
    expect(applied).toMatchObject({ success: false, error: 'mount failed' });
    expect(applied.progress.pendingFolders).toEqual([]);
    expect(applied.progress.outcomes).toEqual({ folders: 'done' });
  });

  it('does nothing when there are no picks', async () => {
    const applied = await applyFirstRunFolders();
    expect(applied.success).toBe(true);
    expect(applyProjects).not.toHaveBeenCalled();
  });
});
