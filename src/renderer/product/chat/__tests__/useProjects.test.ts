import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { ProjectCreateProgressEvent } from '../../../../shared/types/projectCreate';

const listProjects = vi.fn();
const selectProject = vi.fn();
const createHost = vi.fn();
const setProjectFolder = vi.fn();
let sendProgress: (event: ProjectCreateProgressEvent) => void = () => undefined;

stubElectronAPI({
  projects: {
    list: (...args: unknown[]) => listProjects(...args),
    select: (...args: unknown[]) => selectProject(...args),
    pickFolder: vi.fn(async (): Promise<{ success: boolean; hostPath: string }> => ({
      success: true,
      hostPath: '/Users/ada/Code/site',
    })),
    createHost: (...args: unknown[]): unknown => createHost(...args),
    onCreateProgress: (callback: (event: ProjectCreateProgressEvent) => void): (() => void) => {
      sendProgress = callback;
      return () => undefined;
    },
  },
  codingFolders: {
    inspectFolder: vi.fn(async () => ({
      success: true,
      hostPath: '/Users/ada/Code/site',
      name: 'site',
      isGit: true,
      refuseMessage: null,
      managed: true,
    })),
    setProjectFolder: (...args: unknown[]): unknown => setProjectFolder(...args),
  },
  hermesChat: {
    listProjectMarks: vi.fn(async () => []),
  },
});

import { useProjects } from '../useProjects';

function renderProjects() {
  const lists: Parameters<typeof useProjects>[0]['lists'] = {
    threads: [],
    setThreads: vi.fn(),
    setChannels: vi.fn(),
    agents: [],
  };
  return renderHook(
    ({ activeThreadId }: { activeThreadId: string | null }) =>
      useProjects({
        cached: null,
        ids: { activeThreadId, sameChat: (a, b) => Boolean(a && a === b) },
        lists,
        activeAgent: null,
        showCenter: vi.fn(),
      }),
    { initialProps: { activeThreadId: 't-site' as string | null } }
  );
}

describe('useProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProjects.mockResolvedValue({ success: true, activeId: 'p1', projects: [] });
    selectProject.mockResolvedValue({ success: true });
  });

  it('follows the open chat without selecting in main, and catches main up for an empty composer', async () => {
    const { result, rerender } = renderProjects();
    await waitFor(() => expect(result.current.activeProjectId).toBe('p1'));

    act(() => result.current.followProject('p2'));
    expect(result.current.activeProjectId).toBe('p2');
    expect(selectProject).not.toHaveBeenCalled();

    // Nothing open: the next send starts a chat in main's active project.
    rerender({ activeThreadId: null });
    await waitFor(() => expect(selectProject).toHaveBeenCalledWith({ projectId: 'p2' }));
  });
});

describe('creating a project from a folder', () => {
  const created = {
    success: true,
    project: { id: 'p-site' },
    projects: [{ id: 'p-site' }],
    activeId: 'p-site',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listProjects.mockResolvedValue({ success: true, activeId: null, projects: [] });
  });

  async function openSheet() {
    const hook = renderProjects();
    await act(async () => hook.result.current.newProject.pick());
    await waitFor(() => expect(hook.result.current.newProject.folder?.hostPath).toBeTruthy());
    return hook;
  }

  it('shows steps at once, follows main, and mounts coding in the same create', async () => {
    let finish: (value: unknown) => void = () => undefined;
    createHost.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { result } = await openSheet();

    act(() => result.current.newProject.create({ name: 'site', coding: true }));
    expect(result.current.newProject.steps?.map((step) => [step.id, step.status])).toEqual([
      ['mount', 'running'],
      ['health', 'pending'],
      ['check', 'pending'],
      ['open', 'pending'],
    ]);
    const payload = createHost.mock.calls[0][0] as { runId: string; coding: boolean };
    expect(payload).toMatchObject({ hostPath: '/Users/ada/Code/site', name: 'site', coding: true });

    // Another run's events are ignored; this run's replace the list.
    act(() => sendProgress({ runId: 'other', steps: [{ id: 'open', status: 'done' }] }));
    act(() =>
      sendProgress({
        runId: payload.runId,
        steps: [
          { id: 'queue', status: 'waiting' },
          { id: 'mount', status: 'pending' },
        ],
      })
    );
    expect(result.current.newProject.steps).toEqual([
      { id: 'queue', status: 'waiting' },
      { id: 'mount', status: 'pending' },
    ]);

    await act(async () => finish(created));
    expect(result.current.newProject.folder).toBeNull();
    expect(result.current.newProject.steps).toBeNull();
    expect(result.current.activeProjectId).toBe('p-site');
    // No second restart for coding.
    expect(setProjectFolder).not.toHaveBeenCalled();
  });

  it('asks about a running coding task, then sends the choice', async () => {
    const busy = { busy: true, sessions: ['Fix login'] };
    createHost.mockResolvedValueOnce({ success: false, error: 'A coding task is running.', codingBusy: busy });
    const { result } = await openSheet();

    await act(async () => result.current.newProject.create({ name: 'site', coding: true }));
    expect(result.current.newProject.steps).toBeNull();
    expect(result.current.newProject.codingBusy).toEqual(busy);
    expect(result.current.newProject.error).toBeNull();

    createHost.mockResolvedValueOnce(created);
    await act(async () =>
      result.current.newProject.create({ name: 'site', coding: true, whenCodingBusy: 'wait' })
    );
    expect(createHost.mock.calls[1][0]).toMatchObject({ whenCodingBusy: 'wait' });
    expect(result.current.newProject.codingBusy).toBeNull();
    expect(result.current.newProject.folder).toBeNull();
  });

  it('marks the running step failed and keeps the sheet open', async () => {
    createHost.mockResolvedValueOnce({ success: false, error: 'Could not share the folder.' });
    const { result } = await openSheet();

    await act(async () => result.current.newProject.create({ name: 'site', coding: false }));
    expect(result.current.newProject.error).toBe('Could not share the folder.');
    expect(result.current.newProject.steps?.[0]).toEqual({ id: 'mount', status: 'error' });
    expect(result.current.newProject.folder).not.toBeNull();
  });

  it('opens the project but keeps the sheet when the coding check fails', async () => {
    createHost.mockResolvedValueOnce({ ...created, codingError: 'The coding agent can’t open it.' });
    const { result } = await openSheet();

    await act(async () => result.current.newProject.create({ name: 'site', coding: true }));
    expect(result.current.activeProjectId).toBe('p-site');
    expect(result.current.newProject.codingError).toBe('The coding agent can’t open it.');
    expect(result.current.newProject.folder).not.toBeNull();

    act(() => result.current.newProject.cancel());
    expect(result.current.newProject.folder).toBeNull();
    expect(result.current.newProject.codingError).toBeNull();
    expect(result.current.newProject.steps).toBeNull();
  });
});
