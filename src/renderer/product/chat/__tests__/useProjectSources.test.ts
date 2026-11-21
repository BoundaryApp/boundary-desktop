import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  CodingCreateFolderResult,
  CodingFoldersResult,
  CodingGrantRow,
} from '../../../../shared/types/codingFolders';
import type {
  HermesProjectRecord,
  HermesProjectSourcesInspect,
} from '../../../../shared/types/hermesChat';

const inspectSources = vi.fn();
const addSourceFolder = vi.fn();
const removeSource = vi.fn();
const listCodingFolders = vi.fn();
const grantCodingFolder = vi.fn();
const revokeCodingFolder = vi.fn();
const createFolder = vi.fn();

stubElectronAPI({
  projects: {
    inspectSources: (...args: unknown[]) => inspectSources(...args),
    addSourceFolder: (...args: unknown[]) => addSourceFolder(...args),
    removeSource: (...args: unknown[]) => removeSource(...args),
  },
  codingFolders: {
    list: (...args: unknown[]) => listCodingFolders(...args),
    grant: (...args: unknown[]) => grantCodingFolder(...args),
    revoke: (...args: unknown[]) => revokeCodingFolder(...args),
    createFolder: (...args: unknown[]) => createFolder(...args),
    onProgress: () => (): void => undefined,
  },
});

import { getCodingFoldersState, resetCodingFoldersStoreForTests } from '../codingFoldersStore';
import type { NewFolderInput } from '../NewFolderForm';
import { useProjectSources } from '../useProjectSources';

const SITE = '/Users/ada/Code/site';
const project = { id: 'p1' } as HermesProjectRecord;

const grantRow = (resource: string): CodingGrantRow => ({
  capability: 'coding',
  resource,
  createdAt: '2026-11-18T00:00:00.000Z',
  expiresAt: null,
  projectId: 'p1',
  origin: 'add',
  createdByBoundary: false,
  state: 'ready',
  hermesPending: false,
});

const granted = (...paths: string[]): CodingFoldersResult => ({
  success: true,
  managed: true,
  grants: paths.map(grantRow),
});

const inspectWith = (...rows: { id: string; hostPath: string }[]): HermesProjectSourcesInspect =>
  ({ projectId: 'p1', stale: false, sources: rows }) as unknown as HermesProjectSourcesInspect;

function renderSources() {
  const projects = {
    setConnecting: vi.fn(),
    setProjectError: vi.fn(),
    setProjectToast: vi.fn(),
    applyProjectsResult: vi.fn(),
    refreshProjects: vi.fn(async () => undefined),
  };
  const hook = renderHook(() => useProjectSources(project, projects));
  return { ...hook, projects };
}

/** The toast set most recently, skipping the clears. */
function lastToast(setProjectToast: ReturnType<typeof vi.fn>) {
  const shown = setProjectToast.mock.calls.map(([toast]) => toast).filter(Boolean);
  return shown[shown.length - 1] as { text: string; undo?: () => void } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCodingFoldersStoreForTests();
  inspectSources.mockResolvedValue({ success: true, inspect: inspectWith() });
  listCodingFolders.mockResolvedValue(granted());
  addSourceFolder.mockResolvedValue({ success: true, inspect: inspectWith() });
  removeSource.mockResolvedValue({ success: true, inspect: inspectWith() });
});

describe('adding a folder as reference', () => {
  it('lists the folder and closes the sheet', async () => {
    const listed = inspectWith({ id: 's-site', hostPath: SITE });
    addSourceFolder.mockResolvedValue({ success: true, inspect: listed });
    const { result } = renderSources();
    act(() => result.current.addFolder.show());

    act(() => result.current.addFolder.reference(SITE));

    await waitFor(() => expect(result.current.inspect).toBe(listed));
    expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: SITE });
    expect(result.current.addFolder.open).toBe(false);
    expect(grantCodingFolder).not.toHaveBeenCalled();
  });

  it('keeps the sheet open with the error when the add fails', async () => {
    addSourceFolder.mockResolvedValue({ success: false, error: 'That folder is gone.' });
    const { result } = renderSources();
    act(() => result.current.addFolder.show());

    act(() => result.current.addFolder.reference(SITE));

    await waitFor(() => expect(result.current.addFolder.error).toBe('That folder is gone.'));
    expect(result.current.addFolder.open).toBe(true);
  });
});

describe('adding a folder to code in', () => {
  it('grants it, lists it, and says it is ready for coding', async () => {
    grantCodingFolder.mockResolvedValue(granted(SITE));
    const { result, projects } = renderSources();

    act(() => result.current.addFolder.code(SITE, 'now'));

    await waitFor(() =>
      expect(lastToast(projects.setProjectToast)?.text).toBe('site is ready for coding')
    );
    expect(grantCodingFolder).toHaveBeenCalledWith(
      expect.objectContaining({ hostPath: SITE, projectId: 'p1', stopRunningTask: false })
    );
    expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: SITE });
    expect(result.current.addFolder.open).toBe(false);
  });

  it('says a coding task started instead, and lists nothing, when main refuses as busy', async () => {
    grantCodingFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants: [],
      busy: { busy: true, sessions: ['Fix the tests'] },
    } satisfies CodingFoldersResult);
    const { result, projects } = renderSources();

    act(() => result.current.addFolder.code(SITE, 'now'));

    await waitFor(() =>
      expect(lastToast(projects.setProjectToast)?.text).toBe(
        'A coding task started, so site wasn’t added. Try again to wait for it or stop it.'
      )
    );
    expect(addSourceFolder).not.toHaveBeenCalled();
    expect(projects.setProjectToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'site is ready for coding' })
    );
  });

  it('Undo revokes the grant, then removes the row', async () => {
    grantCodingFolder.mockResolvedValue(granted(SITE));
    revokeCodingFolder.mockResolvedValue(granted());
    const { result, projects } = renderSources();
    act(() => result.current.addFolder.code(SITE, 'now'));
    await waitFor(() => expect(lastToast(projects.setProjectToast)?.undo).toBeDefined());
    inspectSources.mockResolvedValue({
      success: true,
      inspect: inspectWith({ id: 's-site', hostPath: SITE }),
    });

    act(() => lastToast(projects.setProjectToast)!.undo!());

    expect(projects.setProjectToast).toHaveBeenLastCalledWith(null);
    await waitFor(() =>
      expect(removeSource).toHaveBeenCalledWith({ projectId: 'p1', sourceId: 's-site' })
    );
    expect(revokeCodingFolder).toHaveBeenCalledWith({ hostPath: SITE, stopRunningTask: true });
    expect(revokeCodingFolder.mock.invocationCallOrder[0]).toBeLessThan(
      removeSource.mock.invocationCallOrder[0]
    );
  });
});

describe('removing a folder', () => {
  it('keeps the row when revoking its grant fails', async () => {
    listCodingFolders.mockResolvedValue(granted(SITE));
    inspectSources.mockResolvedValue({
      success: true,
      inspect: inspectWith({ id: 's-site', hostPath: SITE }),
    });
    revokeCodingFolder.mockResolvedValue({ ...granted(SITE), success: false, error: 'No.' });
    const { result, projects } = renderSources();
    await waitFor(() => expect(result.current.inspect?.sources).toHaveLength(1));
    await waitFor(() => expect(getCodingFoldersState().grants).toHaveLength(1));

    act(() => result.current.removeSource('s-site'));

    await waitFor(() => expect(projects.setConnecting).toHaveBeenLastCalledWith(false));
    expect(revokeCodingFolder).toHaveBeenCalledWith({ hostPath: SITE, stopRunningTask: true });
    expect(removeSource).not.toHaveBeenCalled();
  });

  it('removes a reference folder without touching grants', async () => {
    inspectSources.mockResolvedValue({
      success: true,
      inspect: inspectWith({ id: 's-docs', hostPath: '/Users/ada/Docs' }),
    });
    const { result } = renderSources();
    await waitFor(() => expect(result.current.inspect?.sources).toHaveLength(1));

    act(() => result.current.removeSource('s-docs'));

    await waitFor(() =>
      expect(removeSource).toHaveBeenCalledWith({ projectId: 'p1', sourceId: 's-docs' })
    );
    expect(revokeCodingFolder).not.toHaveBeenCalled();
  });
});

describe('New folder…', () => {
  const base = { parent: '/Users/ada/Code/', name: 'notes', initGit: true, mode: 'now' } as const;
  const asReference: NewFolderInput = { ...base, access: 'reference' };
  const toCode: NewFolderInput = { ...base, access: 'code' };
  const NOTES = '/Users/ada/Code/notes';

  it('as reference: creates it without a grant, then lists it', async () => {
    createFolder.mockResolvedValue({
      success: true,
      managed: true,
      grants: [],
      hostPath: NOTES,
    } satisfies CodingCreateFolderResult);
    const { result } = renderSources();
    act(() => result.current.addFolder.show());

    act(() => result.current.addFolder.createFolder(asReference));

    await waitFor(() =>
      expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: NOTES })
    );
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'notes', grant: false, stopRunningTask: false })
    );
    await waitFor(() => expect(result.current.addFolder.open).toBe(false));
  });

  it('as reference: shows the error in the sheet when creating fails', async () => {
    createFolder.mockResolvedValue({ success: false, managed: true, grants: [], error: 'Exists.' });
    const { result } = renderSources();
    act(() => result.current.addFolder.show());

    act(() => result.current.addFolder.createFolder(asReference));

    await waitFor(() => expect(result.current.addFolder.error).toBe('Exists.'));
    expect(addSourceFolder).not.toHaveBeenCalled();
    expect(result.current.addFolder.open).toBe(true);
  });

  it('to code in: creates it with a grant, lists it, and says so', async () => {
    createFolder.mockResolvedValue({
      ...granted(NOTES),
      hostPath: NOTES,
    } satisfies CodingCreateFolderResult);
    const { result, projects } = renderSources();

    act(() => result.current.addFolder.createFolder(toCode));

    await waitFor(() =>
      expect(lastToast(projects.setProjectToast)?.text).toBe(
        'Created notes and it’s ready for coding'
      )
    );
    expect(createFolder).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'notes', grant: true, stopRunningTask: false })
    );
    expect(addSourceFolder).toHaveBeenCalledWith({ projectId: 'p1', hostPath: NOTES });
  });

  it('to code in: says a coding task started when main refuses as busy', async () => {
    createFolder.mockResolvedValue({
      success: false,
      managed: true,
      grants: [],
      busy: { busy: true, sessions: [] },
    } satisfies CodingCreateFolderResult);
    const { result, projects } = renderSources();

    act(() => result.current.addFolder.createFolder(toCode));

    await waitFor(() =>
      expect(lastToast(projects.setProjectToast)?.text).toBe(
        'A coding task started, so notes wasn’t created. Try again to wait for it or stop it.'
      )
    );
    expect(addSourceFolder).not.toHaveBeenCalled();
  });
});
