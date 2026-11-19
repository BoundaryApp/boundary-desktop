import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  fromWebContents: vi.fn().mockReturnValue(null),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  dialog: { showOpenDialog: electron.showOpenDialog },
}));

const project = vi.hoisted(() => ({ hostPath: '' }));
vi.mock('../hermesProjectStore', () => ({
  getStoredHermesProject: (id: string) =>
    id === 'p1' ? { id: 'p1', name: 'Job Search', hostPath: project.hostPath } : null,
}));

const log = vi.hoisted(() => vi.fn());
vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: log }));
vi.mock('../../../dialogFolders', () => ({ rememberDialogPick: vi.fn() }));

import { pickProjectFileForCheck, readProjectFileForCheck } from '../writingCheckFiles';

const sender = {} as Electron.WebContents;

describe('reading a project file for the writing check', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wc-files-'));
    project.hostPath = path.join(root, 'Job Search');
    outside = path.join(root, 'elsewhere');
    await fs.mkdir(path.join(project.hostPath, 'letters'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(project.hostPath, 'letters', 'acme.md'), '# Acme\n\nWe delve in.\n');
    await fs.writeFile(path.join(outside, 'secret.md'), 'not yours');
    log.mockClear();
    electron.showOpenDialog.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads a markdown file inside the project, with its modified time', async () => {
    const result = await readProjectFileForCheck({ projectId: 'p1', relativePath: 'letters/acme.md' });
    expect(result.success).toBe(true);
    expect(result.file?.text).toBe('# Acme\n\nWe delve in.\n');
    expect(result.file?.relativePath).toBe('letters/acme.md');
    expect(Number.isNaN(Date.parse(result.file?.modifiedAt ?? ''))).toBe(false);
  });

  it('logs the outcome, type and size, never the path or text', async () => {
    await readProjectFileForCheck({ projectId: 'p1', relativePath: 'letters/acme.md' });
    const [area, message, data] = log.mock.calls[0];
    expect(area).toBe('writing-check');
    expect(message).toBe('file read');
    expect(data).toMatchObject({ outcome: 'ok', ext: '.md', bytes: Buffer.byteLength('# Acme\n\nWe delve in.\n') });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/acme|delve|Job Search/);
  });

  it.each([
    ['a path that leaves the folder', '../elsewhere/secret.md', 'That file is outside the project folder.'],
    ['an absolute path', '/etc/hosts', 'That file is outside the project folder.'],
    ['an unsupported type', 'letters/photo.png', 'Only .md, .markdown and .txt files can be checked.'],
    ['a missing file', 'letters/gone.md', 'That file no longer exists.'],
    ['a folder', 'letters', 'Only .md, .markdown and .txt files can be checked.'],
  ])('refuses %s', async (_label, relativePath, error) => {
    const result = await readProjectFileForCheck({ projectId: 'p1', relativePath });
    expect(result).toEqual({ success: false, error });
  });

  it('refuses a symlink that points out of the project', async () => {
    await fs.symlink(path.join(outside, 'secret.md'), path.join(project.hostPath, 'link.md'));
    const result = await readProjectFileForCheck({ projectId: 'p1', relativePath: 'link.md' });
    expect(result).toEqual({ success: false, error: 'That file is outside the project folder.' });
  });

  it('refuses a file over 1 MB without reading it', async () => {
    await fs.writeFile(path.join(project.hostPath, 'big.txt'), 'a'.repeat(1024 * 1024 + 1));
    const result = await readProjectFileForCheck({ projectId: 'p1', relativePath: 'big.txt' });
    expect(result).toEqual({ success: false, error: 'That file is over 1 MB, too large to check.' });
  });

  it('refuses a file that is not text', async () => {
    await fs.writeFile(path.join(project.hostPath, 'odd.txt'), Buffer.from([0x41, 0x00, 0x42]));
    const result = await readProjectFileForCheck({ projectId: 'p1', relativePath: 'odd.txt' });
    expect(result).toEqual({ success: false, error: 'That file is not plain text.' });
  });

  it('refuses an unknown project', async () => {
    const result = await readProjectFileForCheck({ projectId: 'nope', relativePath: 'letters/acme.md' });
    expect(result).toEqual({ success: false, error: 'Project not found.' });
  });

  describe('Check a file…', () => {
    it('opens in the project folder, limited to text types, and reads the pick', async () => {
      electron.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [path.join(project.hostPath, 'letters', 'acme.md')],
      });
      const result = await pickProjectFileForCheck(sender, { projectId: 'p1' });
      const options = electron.showOpenDialog.mock.calls[0][0];
      expect(options.defaultPath).toBe(project.hostPath);
      expect(options.filters).toEqual([{ name: 'Text', extensions: ['md', 'markdown', 'txt'] }]);
      expect(result.file?.relativePath).toBe('letters/acme.md');
    });

    it('refuses a pick outside the project', async () => {
      electron.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [path.join(outside, 'secret.md')],
      });
      const result = await pickProjectFileForCheck(sender, { projectId: 'p1' });
      expect(result).toEqual({ success: false, error: 'That file is outside the project folder.' });
    });

    it('reports a cancel', async () => {
      electron.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      expect(await pickProjectFileForCheck(sender, { projectId: 'p1' })).toEqual({
        success: false,
        canceled: true,
      });
    });
  });
});
