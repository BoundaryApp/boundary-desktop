import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  fromWebContents: vi.fn().mockReturnValue(null),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
  dialog: { showSaveDialog: electron.showSaveDialog },
  shell: { showItemInFolder: electron.showItemInFolder },
}));

const project = vi.hoisted(() => ({ hostPath: '' }));
vi.mock('../hermesProjectStore', () => ({
  getStoredHermesProject: (id: string) =>
    id === 'p1' ? { id: 'p1', name: 'Job Search', hostPath: project.hostPath } : null,
}));

import {
  resolveInsideProject,
  revealProjectFile,
  saveReplyToProject,
  suggestReplyFileName,
} from '../hermesReplyFiles';

describe('resolveInsideProject', () => {
  it('keeps paths inside the project folder and refuses ones that leave it', () => {
    expect(resolveInsideProject('/Users/ada/Job Search', 'letters/acme.md')).toBe(
      '/Users/ada/Job Search/letters/acme.md'
    );
    expect(resolveInsideProject('/Users/ada/Job Search', '../secrets.txt')).toBeNull();
    expect(resolveInsideProject('/Users/ada/Job Search', '/etc/passwd')).toBeNull();
    expect(resolveInsideProject('/Users/ada/Job', '../Job Search/x')).toBeNull();
  });
});

describe('suggestReplyFileName', () => {
  it('names the file after the first heading or line', () => {
    expect(suggestReplyFileName('## Cover letter for **Acme**\n\nBody')).toBe(
      'cover-letter-for-acme.md'
    );
    expect(suggestReplyFileName('\n\n> Quick summary: pros & cons')).toBe(
      'quick-summary-pros-cons.md'
    );
  });

  it('falls back to a dated name', () => {
    expect(suggestReplyFileName('```\n```', new Date('2026-09-30T12:00:00Z'))).toBe(
      'reply-2026-09-30.md'
    );
  });
});

describe('save and reveal', () => {
  let dir: string;
  const sender = {} as never;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'boundary-reply-'));
    project.hostPath = dir;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('opens the save dialog in the project folder and writes where the user picked', async () => {
    const picked = path.join(dir, 'chosen.md');
    electron.showSaveDialog.mockResolvedValue({ canceled: false, filePath: picked });

    const result = await saveReplyToProject(sender, {
      projectId: 'p1',
      content: '# Cover letter\n\nHello',
    });

    expect(electron.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: path.join(dir, 'cover-letter.md') })
    );
    expect(result).toEqual({ success: true, path: picked });
    expect(await fs.readFile(picked, 'utf8')).toBe('# Cover letter\n\nHello\n');
  });

  it('writes nothing when the dialog is closed', async () => {
    electron.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const result = await saveReplyToProject(sender, { projectId: 'p1', content: 'x' });
    expect(result).toEqual({ success: false, canceled: true });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('refuses an unknown project', async () => {
    const result = await saveReplyToProject(sender, { projectId: 'nope', content: 'x' });
    expect(result.success).toBe(false);
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
  });

  it('reveals an existing file inside the project', async () => {
    await fs.mkdir(path.join(dir, 'letters'));
    await fs.writeFile(path.join(dir, 'letters', 'acme.md'), 'x');
    const result = await revealProjectFile({ projectId: 'p1', relativePath: 'letters/acme.md' });
    expect(result).toEqual({ success: true });
    expect(electron.showItemInFolder).toHaveBeenCalledWith(path.join(dir, 'letters', 'acme.md'));
  });

  it('does not reveal outside the project or a missing file', async () => {
    expect(
      await revealProjectFile({ projectId: 'p1', relativePath: '../outside.md' })
    ).toMatchObject({ success: false });
    expect(await revealProjectFile({ projectId: 'p1', relativePath: 'gone.md' })).toMatchObject({
      success: false,
    });
    expect(electron.showItemInFolder).not.toHaveBeenCalled();
  });
});
