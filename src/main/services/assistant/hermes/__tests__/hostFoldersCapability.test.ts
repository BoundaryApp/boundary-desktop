import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STACK_CAPABILITY_MISSING_TEXT } from '../../../../../shared/stackCapabilities';
import type { HermesProjectRecord } from '../../../../../shared/types/hermesChat';
import { createFakeStackHost, type FakeStackHost } from '../../../stackHost/fakeStackHost';

// Features that bind a folder on this machine into a container, on a host without hostFolders.

const h = vi.hoisted(() => ({ host: null as unknown as FakeStackHost }));

vi.mock('../../../stackHost/capabilities', async () =>
  (await import('../../../stackHost/fakeStackHost')).fakeCapabilitiesModule(() => h.host.capabilities)
);

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock('electron', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    app: { getPath: () => path.join(os.tmpdir(), 'host-folders-capability'), getName: () => 'Boundary' },
    BrowserWindow: { fromWebContents: (): null => null },
    dialog: { showOpenDialog: electron.showOpenDialog, showSaveDialog: electron.showSaveDialog },
    shell: { showItemInFolder: electron.showItemInFolder, openPath: electron.openPath },
  };
});

const project: HermesProjectRecord = {
  id: 'p1',
  name: 'Notes',
  kind: 'host-folder',
  hostPath: '/Users/someone/notes',
  containerPath: '/opt/projects/notes',
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
} as HermesProjectRecord;

vi.mock('../hermesProjectStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getStoredHermesProject: (id: string) => (id === 'p1' ? project : null),
  listStoredHermesProjects: () => [project],
}));

import { readHtmlPreview } from '../htmlPreviewFiles';
import { revealProjectFile, saveReplyToProject } from '../hermesReplyFiles';
import { pickProjectFileForCheck, readProjectFileForCheck } from '../writingCheckFiles';
import {
  changeHermesProjectFolder,
  createEmptyHermesProject,
  createHostFolderHermesProject,
  revealHermesProjectInFinder,
} from '../hermesProjects';
import {
  addHermesProjectSourceFolder,
  countHermesProjectExtraSources,
  inspectHermesProjectSources,
  refreshHermesProjectIndex,
  removeHermesProjectSource,
  revealHermesProjectSource,
} from '../hermesProjectSources';
import { revealHermesAgentSoul } from '../hermesAgents';
import { collectContextExtraRoots, upsertHermesContextOverrideBinds } from '../hermesContextRoots';
import { resolveHermesProjectsOverlayPath, writeHermesProjectsOverlay } from '../hermesProjectsOverlay';
import { grantCoding, setProjectFolderCoding } from '../../coding/codingGrants';
import { createCodingFolder, pickCodingFolder } from '../../coding/codingNewFolder';

const refusal = STACK_CAPABILITY_MISSING_TEXT.hostFolders;
const sender = {} as Electron.WebContents;

describe('features that need hostFolders, on a host without it', () => {
  beforeEach(() => {
    h.host = createFakeStackHost({ capabilities: { hostFolders: false } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('projects from folders on this machine refuse with the capability text', async () => {
    await expect(
      createHostFolderHermesProject({ hostPath: '/Users/someone/notes', name: 'Notes' })
    ).resolves.toMatchObject({ success: false, error: refusal });
    await expect(createEmptyHermesProject({ name: 'Empty' })).resolves.toEqual({ success: false, error: refusal });
    await expect(
      changeHermesProjectFolder({ projectId: 'p1', hostPath: '/Users/someone/other' })
    ).resolves.toMatchObject({ success: false, error: refusal });
    await expect(revealHermesProjectInFinder('p1')).resolves.toEqual({ success: false, error: refusal });
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it('project sources refuse, and count none', async () => {
    for (const result of [
      await addHermesProjectSourceFolder('p1', '/Users/someone/more'),
      await inspectHermesProjectSources('p1'),
      await removeHermesProjectSource('p1', 'more'),
      await revealHermesProjectSource('p1', 'project'),
      await refreshHermesProjectIndex('p1'),
    ]) {
      expect(result).toEqual({ success: false, error: refusal });
    }
    expect(countHermesProjectExtraSources('p1')).toBeNull();
  });

  it('coding folders refuse before any dialog or remount', async () => {
    const refused = { success: false, managed: true, grants: [] as unknown[], error: refusal };
    await expect(grantCoding({ projectId: 'p1', hostPath: '/Users/someone/code', origin: 'chat' })).resolves.toEqual(refused);
    await expect(setProjectFolderCoding({ projectId: 'p1', enabled: true })).resolves.toEqual(refused);
    await expect(createCodingFolder({ projectId: null, parent: '/Users/someone', name: 'code', initGit: false })).resolves.toEqual(refused);
    await expect(pickCodingFolder()).resolves.toEqual({ success: false, refuseMessage: refusal });
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });

  it('files in project folders refuse', async () => {
    await expect(
      readHtmlPreview({ containerPath: '/opt/projects/notes/page.html' }, { projectsRoot: '/x', hostFolders: [] })
    ).resolves.toEqual({
      success: false,
      error: refusal,
    });
    await expect(saveReplyToProject(sender, { projectId: 'p1', content: '# Hi' })).resolves.toEqual({
      success: false,
      error: refusal,
    });
    await expect(revealProjectFile({ projectId: 'p1', relativePath: 'a.md' })).resolves.toEqual({
      success: false,
      error: refusal,
    });
    await expect(readProjectFileForCheck({ projectId: 'p1', relativePath: 'a.md' })).resolves.toEqual({
      success: false,
      error: refusal,
    });
    await expect(pickProjectFileForCheck(sender, { projectId: 'p1' })).resolves.toEqual({
      success: false,
      error: refusal,
    });
    expect(revealHermesAgentSoul({ slug: 'assistant' })).toEqual({ success: false, error: refusal });
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
  });

  it('context roots and the projects overlay bind nothing from this machine', async () => {
    await expect(
      collectContextExtraRoots({ env: { CONTEXT_EXTRA_ROOTS: '/Users/someone/docs' }, projects: [project] })
    ).resolves.toEqual([]);

    await upsertHermesContextOverrideBinds(['/Users/someone/docs'], h.host.files);
    expect(h.host.files.files.size).toBe(0);

    const overlay = await writeHermesProjectsOverlay([project], ['/Users/someone/docs']);
    expect(overlay).toBe(resolveHermesProjectsOverlayPath());
    const yaml = fs.readFileSync(overlay, 'utf8');
    expect(yaml).toContain('services: {}');
    expect(yaml).not.toContain('/Users/someone');
  });
});
