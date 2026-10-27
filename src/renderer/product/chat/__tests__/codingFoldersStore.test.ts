import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { CodingFoldersResult } from '../../../../shared/types/codingFolders';

const codingAgentBusy = vi.fn();
const listCodingFolders = vi.fn();
const grantCodingFolder = vi.fn();
const addSourceFolder = vi.fn();

stubElectronAPI({
  codingFolders: {
    busy: (...args: unknown[]) => codingAgentBusy(...args),
    list: (...args: unknown[]) => listCodingFolders(...args),
    grant: (...args: unknown[]) => grantCodingFolder(...args),
    onProgress: () => () => undefined,
  },
  projects: {
    addSourceFolder: (...args: unknown[]) => addSourceFolder(...args),
  },
});

import {
  codingChange,
  forceQueuedCodingChanges,
  grantAndList,
  readCodingAgentBusy,
  getCodingFoldersState,
  onCodingGrantsChanged,
  queueCodingChange,
  resetCodingFoldersStoreForTests,
  runCodingChange,
} from '../codingFoldersStore';

const ok: CodingFoldersResult = { success: true, managed: true, grants: [] };

beforeEach(() => {
  resetCodingFoldersStoreForTests();
  codingAgentBusy.mockReset();
  listCodingFolders.mockResolvedValue(ok);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runCodingChange', () => {
  it('shows the folder as connecting while the change runs, then applies the result', async () => {
    const changed = vi.fn();
    onCodingGrantsChanged(changed);
    let finish: (result: CodingFoldersResult) => void = () => undefined;
    const running = runCodingChange(
      ['/Users/ada/Code/a/'],
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    expect(getCodingFoldersState().pending).toEqual({ '/Users/ada/Code/a': 'connecting' });
    expect(getCodingFoldersState().step).toBe(0);
    finish({ ...ok, grants: [] });
    await running;
    expect(getCodingFoldersState().pending).toEqual({});
    expect(getCodingFoldersState().step).toBeNull();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('keeps the error for the banner, but not for a busy refusal', async () => {
    await runCodingChange(['/a'], async () => ({ ...ok, success: false, error: 'compose failed' }));
    expect(getCodingFoldersState().error).toEqual({ hostPath: '/a', message: 'compose failed' });
    await runCodingChange(['/a'], async () => ({
      ...ok,
      success: false,
      error: 'A coding task is running.',
      busy: { busy: true, sessions: ['x'] },
    }));
    expect(getCodingFoldersState().error).toBeNull();
  });

  it('turns a thrown error into a failed result', async () => {
    const result = await runCodingChange(['/a'], async () => {
      throw new Error('ipc gone');
    });
    expect(result.success).toBe(false);
    expect(getCodingFoldersState().error?.message).toBe('ipc gone');
  });
});

describe('queueCodingChange', () => {
  it('waits while a coding task runs, then runs without stopping it', async () => {
    codingAgentBusy
      .mockResolvedValueOnce({ busy: true, sessions: ['Fix header layout'] })
      .mockResolvedValueOnce({ busy: true, sessions: ['Fix header layout'] })
      .mockResolvedValueOnce({ busy: false, sessions: [] });
    const run = vi.fn(async () => ok);
    const done = queueCodingChange(['/a'], run, 150);
    expect(getCodingFoldersState().pending).toEqual({ '/a': 'queued' });
    await vi.waitFor(() => expect(getCodingFoldersState().waitingFor).toEqual(['Fix header layout']));
    await done;
    expect(run).toHaveBeenCalledWith(false);
    expect(getCodingFoldersState().pending).toEqual({});
    expect(getCodingFoldersState().waitingFor).toEqual([]);
  });

  it('stops the task when the user forces it', async () => {
    codingAgentBusy.mockResolvedValue({ busy: true, sessions: ['x'] });
    const run = vi.fn(async () => ok);
    const done = queueCodingChange(['/a'], run, 5);
    await vi.waitFor(() => expect(codingAgentBusy).toHaveBeenCalled());
    forceQueuedCodingChanges();
    await done;
    expect(run).toHaveBeenCalledWith(true);
  });
});

describe('codingChange', () => {
  it('runs now without stopping, stops for stop, and waits for queue', async () => {
    codingAgentBusy.mockResolvedValue({ busy: false, sessions: [] });
    const run = vi.fn(async () => ok);
    await codingChange(['/a'], 'now', run);
    await codingChange(['/a'], 'stop', run);
    await codingChange(['/a'], 'queue', run);
    expect(run.mock.calls).toEqual([[false], [true], [false]]);
    expect(codingAgentBusy).toHaveBeenCalledTimes(1);
  });
});

describe('grantAndList', () => {
  it('lists the folder in the project only when the grant is in', async () => {
    grantCodingFolder.mockResolvedValueOnce({ ...ok, grants: [{ resource: '/a' }] });
    await grantAndList({ projectId: 'p1', hostPath: '/a', origin: 'add' })(false);
    expect(grantCodingFolder).toHaveBeenCalledWith({
      projectId: 'p1',
      hostPath: '/a',
      origin: 'add',
      stopRunningTask: false,
    });
    expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: '/a' });

    addSourceFolder.mockClear();
    grantCodingFolder.mockResolvedValueOnce({
      ...ok,
      success: false,
      busy: { busy: true, sessions: ['x'] },
    });
    const refused = await grantAndList({ projectId: 'p1', hostPath: '/a', origin: 'add' })(false);
    expect(refused.busy?.busy).toBe(true);
    expect(addSourceFolder).not.toHaveBeenCalled();
  });
});

describe('readCodingAgentBusy', () => {
  it('counts a failed call as not busy', async () => {
    codingAgentBusy.mockRejectedValue(new Error('ipc gone'));
    expect(await readCodingAgentBusy()).toEqual({ busy: false, sessions: [] });
  });
});
