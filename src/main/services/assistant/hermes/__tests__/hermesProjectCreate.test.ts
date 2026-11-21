import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectMountRecreateOptions } from '../../AssistantStackService';
import type {
  ProjectCreateProgressEvent,
  ProjectCreateStepStatus,
} from '../../../../../shared/types/projectCreate';

const recreate = vi.fn();

vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    setActiveProject: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue({ projects: [], activeId: null }),
  }),
}));

vi.mock('../../AssistantStackService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../AssistantStackService')>()),
  recreateHermesForProjectMounts: (options?: ProjectMountRecreateOptions) => recreate(options),
}));

vi.mock('../hermesProjectsOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermesProjectsOverlay')>()),
  writeHermesProjectsOverlay: vi.fn(),
  ensureProjectMountPoints: vi.fn(),
}));

vi.mock('../../coding/codingMounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coding/codingMounts')>()),
  persistCodingStackEnv: vi.fn(),
}));

let envRoot = '';
vi.mock('../../resolveAssistantRoot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../resolveAssistantRoot')>()),
  resolveActiveAssistantRoot: () => envRoot,
}));

import {
  resetCodingRemountQueueForTests,
} from '../../coding/codingGrants';
import { getCodingGrantStates, resetCodingGrantStoreForTests } from '../../coding/codingGrantStore';
import { fakeCodingDeps, makeFolder, resetCodingDepsForTests } from '../../coding/__tests__/codingDeps';
import { CODING_TASK_POLL_MS, createHostFolderHermesProject } from '../hermesProjects';
import { listStoredHermesProjects, resetHermesProjectsStoreForTests } from '../hermesProjectStore';
import { setProjectCreateEmitForTests } from '../projectCreateSteps';
import { holdFolderRemounts } from '../projectMountState';

let tmp: string;
let events: ProjectCreateProgressEvent[];

function dir(...parts: string[]): string {
  return makeFolder(tmp, ...parts);
}

/** The last state each step reached, in order. */
function finalSteps(): Record<string, ProjectCreateStepStatus> {
  const last = events.at(-1);
  return Object.fromEntries((last?.steps ?? []).map((step) => [step.id, step.status]));
}

/** Every status one step went through. */
function history(id: string): ProjectCreateStepStatus[] {
  const seen: ProjectCreateStepStatus[] = [];
  for (const event of events) {
    const status = event.steps.find((step) => step.id === id)?.status;
    if (status && seen.at(-1) !== status) seen.push(status);
  }
  return seen;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-create-')));
  envRoot = dir('stack');
  resetHermesProjectsStoreForTests();
  resetCodingGrantStoreForTests();
  resetCodingRemountQueueForTests();
  recreate.mockReset().mockImplementation(async (options?: ProjectMountRecreateOptions) => {
    options?.onHealthWait?.();
    return { success: true };
  });
  events = [];
  setProjectCreateEmitForTests((event) => events.push(event));
});

afterEach(() => {
  vi.useRealTimers();
  resetCodingDepsForTests();
  setProjectCreateEmitForTests(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('creating a project from a folder with coding on', () => {
  it('mounts the folder and the coding agent in one restart', async () => {
    const calls = fakeCodingDeps({ home: tmp });
    const folder = dir('site');

    const result = await createHostFolderHermesProject({
      hostPath: folder,
      coding: true,
      runId: 'run-1',
    });

    expect(result.success).toBe(true);
    expect(result.codingError).toBeUndefined();
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(recreate.mock.calls[0][0]).toMatchObject({ codingAgent: true });
    // The coding remount's own restart never ran.
    expect(calls.recreate).toBe(0);
    expect(listStoredHermesProjects()[0]).toMatchObject({ hostPath: folder, codingEnabled: true });
    expect(getCodingGrantStates()[folder]).toBe('ready');
    expect(calls.audit.map((entry) => [entry.tool, entry.decision])).toEqual([
      ['coding_grant', 'allowed'],
    ]);
    expect(events.every((event) => event.runId === 'run-1')).toBe(true);
    expect(finalSteps()).toEqual({ mount: 'done', health: 'done', check: 'done', open: 'done' });
    expect(history('mount')).toEqual(['pending', 'running', 'done']);
    expect(history('health')).toEqual(['pending', 'running', 'done']);
  });

  it('opens the project but reports a folder the coding agent cannot open', async () => {
    fakeCodingDeps({ home: tmp, overrides: { verify: async () => false } });
    const folder = dir('site');

    const result = await createHostFolderHermesProject({ hostPath: folder, coding: true, runId: 'r' });

    expect(result.success).toBe(true);
    expect(result.codingError).toMatch(/can’t open/);
    expect(getCodingGrantStates()[folder]).toBe('not-visible');
    expect(finalSteps()).toMatchObject({ check: 'error', open: 'done' });
  });

  it('skips restarting the coding agent when a granted folder already holds this one', async () => {
    const parent = dir('work');
    fakeCodingDeps({ home: tmp, overrides: { busy: async () => ({ busy: true, sessions: [] }) } });
    const { addCodingGrantRecord } = await import('../../coding/codingGrantStore');
    addCodingGrantRecord({ hostPath: parent, projectId: 'other', origin: 'add', createdByBoundary: false });

    const result = await createHostFolderHermesProject({
      hostPath: makeFolder(parent, 'site'),
      coding: true,
    });

    // A running task doesn't matter: nothing restarts the coding agent.
    expect(result.success).toBe(true);
    expect(recreate.mock.calls[0][0]).toMatchObject({ codingAgent: false });
  });

  it('refuses with the running task when the caller has not chosen what to do', async () => {
    const busy = { busy: true, sessions: ['Fix login'] };
    fakeCodingDeps({ home: tmp, overrides: { busy: async () => busy } });

    const result = await createHostFolderHermesProject({ hostPath: dir('site'), coding: true });

    expect(result.success).toBe(false);
    expect(result.codingBusy).toEqual(busy);
    expect(recreate).not.toHaveBeenCalled();
    expect(listStoredHermesProjects()).toEqual([]);
  });

  it('restarts at once when told to stop the running task', async () => {
    fakeCodingDeps({
      home: tmp,
      overrides: { busy: async () => ({ busy: true, sessions: [] }) },
    });

    const result = await createHostFolderHermesProject({
      hostPath: dir('site'),
      coding: true,
      whenCodingBusy: 'stop',
      runId: 'r',
    });

    expect(result.success).toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(finalSteps()).not.toHaveProperty('task');
  });

  it('waits for the running task before restarting when told to wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    let busy = true;
    fakeCodingDeps({ home: tmp, overrides: { busy: async () => ({ busy, sessions: [] }) } });

    const pending = createHostFolderHermesProject({
      hostPath: dir('site'),
      coding: true,
      whenCodingBusy: 'wait',
      runId: 'r',
    });
    await settle();
    expect(finalSteps()).toMatchObject({ task: 'waiting', queue: 'pending' });
    await vi.advanceTimersByTimeAsync(CODING_TASK_POLL_MS);
    expect(recreate).not.toHaveBeenCalled();

    busy = false;
    await vi.advanceTimersByTimeAsync(CODING_TASK_POLL_MS);
    const result = await pending;

    expect(result.success).toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
    expect(history('task')).toEqual(['pending', 'waiting', 'done']);
    expect(finalSteps()).toMatchObject({ task: 'done', queue: 'done', open: 'done' });
  });

  it('marks the restart failed, rolls back and audits the failed grant', async () => {
    const calls = fakeCodingDeps({ home: tmp });
    recreate.mockResolvedValue({ success: false, error: 'compose up failed' });

    const result = await createHostFolderHermesProject({ hostPath: dir('site'), coding: true, runId: 'r' });

    expect(result.success).toBe(false);
    expect(listStoredHermesProjects()).toEqual([]);
    expect(finalSteps()).toMatchObject({ mount: 'error', health: 'pending', check: 'pending' });
    expect(calls.audit.map((entry) => [entry.tool, entry.decision])).toEqual([
      ['coding_grant', 'error'],
    ]);
  });
});

describe('creating a project from a folder with coding off', () => {
  it('leaves the coding agent alone and has no check step', async () => {
    const calls = fakeCodingDeps({ home: tmp });

    const result = await createHostFolderHermesProject({ hostPath: dir('notes'), runId: 'r' });

    expect(result.success).toBe(true);
    expect(recreate.mock.calls[0][0]).toMatchObject({ codingAgent: false });
    expect(listStoredHermesProjects()[0].codingEnabled).toBeUndefined();
    expect(calls.audit).toEqual([]);
    expect(finalSteps()).toEqual({ mount: 'done', health: 'done', open: 'done' });
  });

  it('shows a queue step while another folder change holds the containers', async () => {
    fakeCodingDeps({ home: tmp });
    const release = await holdFolderRemounts();

    const pending = createHostFolderHermesProject({ hostPath: dir('notes'), runId: 'r' });
    await settle();
    expect(finalSteps()).toMatchObject({ queue: 'waiting', mount: 'pending' });

    release();
    expect((await pending).success).toBe(true);
    expect(history('queue')).toEqual(['pending', 'waiting', 'done']);
  });

  it('sends nothing without a run id', async () => {
    fakeCodingDeps({ home: tmp });
    await createHostFolderHermesProject({ hostPath: dir('notes') });
    expect(events).toEqual([]);
  });
});
