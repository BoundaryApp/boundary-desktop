import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_MAX_BYTES } from '../../../../../shared/htmlPreview';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const store = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock('../hermesProjectStore', () => ({
  listStoredHermesProjects: () => store.projects,
}));

import { previewHostPath, readHtmlPreview, type PreviewRoots } from '../htmlPreviewFiles';

const OUTSIDE = {
  success: false,
  error: 'That file is outside the folders Boundary can open.',
};

describe('previewHostPath', () => {
  const roots: PreviewRoots = {
    projectsRoot: '/data/projects',
    hostFolders: [{ containerPath: '/opt/projects/site', hostPath: '/Users/ada/Site' }],
  };

  it('maps /opt/projects to the projects root', () => {
    expect(previewHostPath('/opt/projects/scratch/d.html', roots)).toBe(
      path.join('/data/projects', 'scratch/d.html'),
    );
    expect(previewHostPath('/opt/projects/a/../../etc/x.html', roots)).toBeNull();
    expect(previewHostPath('/opt/data/x.html', roots)).toBeNull();
    expect(previewHostPath('/opt/projects-other/x.html', roots)).toBeNull();
    expect(previewHostPath('/opt/projects', roots)).toBeNull();
  });

  it('prefers a host-folder pair that contains the path', () => {
    expect(previewHostPath('/opt/projects/site/pages/a.html', roots)).toBe(
      '/Users/ada/Site/pages/a.html',
    );
    expect(previewHostPath('/opt/projects/site-two/a.html', roots)).toBe(
      path.join('/data/projects', 'site-two/a.html'),
    );
  });
});

describe('readHtmlPreview', () => {
  let tmp: string;
  let projectsRoot: string;
  let outside: string;
  let roots: PreviewRoots;

  async function write(rel: string, text: string) {
    const file = path.join(projectsRoot, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'boundary-preview-'));
    projectsRoot = path.join(tmp, 'projects');
    outside = path.join(tmp, 'outside');
    await fs.mkdir(path.join(projectsRoot, 'scratch'), { recursive: true });
    await fs.mkdir(outside);
    roots = { projectsRoot, hostFolders: [] };
    store.projects = [];
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns the page text and name', async () => {
    await write('scratch/d.html', '<p>hi</p>');
    expect(await readHtmlPreview({ containerPath: '/opt/projects/scratch/d.html' }, roots)).toEqual(
      {
        success: true,
        html: '<p>hi</p>',
        name: 'd.html',
      },
    );
  });

  it('refuses a symlink that leaves the root', async () => {
    await fs.writeFile(path.join(outside, 'secret.html'), 'x');
    await fs.symlink(
      path.join(outside, 'secret.html'),
      path.join(projectsRoot, 'scratch/link.html'),
    );
    expect(
      await readHtmlPreview({ containerPath: '/opt/projects/scratch/link.html' }, roots),
    ).toEqual(OUTSIDE);
  });

  it('refuses a folder symlink that leaves the root', async () => {
    await fs.writeFile(path.join(outside, 'secret.html'), 'x');
    await fs.symlink(outside, path.join(projectsRoot, 'escape'));
    expect(
      await readHtmlPreview({ containerPath: '/opt/projects/escape/secret.html' }, roots),
    ).toEqual(OUTSIDE);
  });

  it('reads through a projects root that is itself a symlink', async () => {
    const link = path.join(tmp, 'link-root');
    await fs.symlink(projectsRoot, link);
    await write('scratch/d.html', 'ok');
    const result = await readHtmlPreview(
      { containerPath: '/opt/projects/scratch/d.html' },
      { projectsRoot: link, hostFolders: [] },
    );
    expect(result).toMatchObject({ success: true, html: 'ok' });
  });

  it('refuses paths that do not map to a root', async () => {
    expect(await readHtmlPreview({ containerPath: '/opt/projects/../etc/x.html' }, roots)).toEqual(
      OUTSIDE,
    );
    expect(await readHtmlPreview({ containerPath: '/etc/x.html' }, roots)).toEqual(OUTSIDE);
  });

  it('refuses non-HTML, missing and oversized files without naming host paths', async () => {
    await write('scratch/n.md', '# x');
    await write('scratch/big.html', 'x'.repeat(PREVIEW_MAX_BYTES + 1));
    expect(
      (await readHtmlPreview({ containerPath: '/opt/projects/scratch/n.md' }, roots)).error,
    ).toBe('Only .html pages can be previewed.');
    expect(
      (await readHtmlPreview({ containerPath: '/opt/projects/scratch/gone.html' }, roots)).error,
    ).toBe('That file no longer exists.');
    expect(
      (await readHtmlPreview({ containerPath: '/opt/projects/scratch/big.html' }, roots)).error,
    ).toBe('That page is larger than 2 MB.');
  });

  it('returns an error for a FIFO named like a page instead of hanging', async () => {
    execFileSync('mkfifo', [path.join(projectsRoot, 'scratch/x.html')]);
    const result = await readHtmlPreview({ containerPath: '/opt/projects/scratch/x.html' }, roots);
    expect(result.success).toBe(false);
    expect(result.error).toBe('That file no longer exists.');
  });

  it('follows a symlink inside the root and refuses one that points out', async () => {
    // The open uses O_NOFOLLOW on the already resolved path, so a link is read through its
    // real target only; one whose target leaves the roots never reaches the open.
    await write('scratch/real.html', 'ok');
    await fs.symlink('real.html', path.join(projectsRoot, 'scratch/alias.html'));
    await fs.writeFile(path.join(outside, 'o.html'), 'x');
    await fs.symlink(path.join(outside, 'o.html'), path.join(projectsRoot, 'scratch/out.html'));
    expect(
      await readHtmlPreview({ containerPath: '/opt/projects/scratch/alias.html' }, roots),
    ).toMatchObject({ success: true, html: 'ok' });
    expect(
      await readHtmlPreview({ containerPath: '/opt/projects/scratch/out.html' }, roots),
    ).toEqual(OUTSIDE);
  });

  it('refuses a page that grows past the limit after the size check', async () => {
    await write('scratch/grow.html', 'x'.repeat(PREVIEW_MAX_BYTES));
    const file = path.join(projectsRoot, 'scratch/grow.html');
    const realOpen = fs.open;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      await fs.appendFile(file, 'more');
      const stat = handle.stat.bind(handle);
      handle.stat = (async () => {
        const result = await stat();
        return Object.assign(result, { size: 10 });
      }) as typeof handle.stat;
      return handle;
    });
    try {
      const result = await readHtmlPreview(
        { containerPath: '/opt/projects/scratch/grow.html' },
        roots,
      );
      expect(result).toEqual({
        success: false,
        error: 'That page is larger than 2 MB.',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses when the path no longer leads to the opened file', async () => {
    await write('scratch/a.html', 'first');
    await write('scratch/b.html', 'second');
    const realRealpath = fs.realpath;
    let calls = 0;
    const spy = vi.spyOn(fs, 'realpath').mockImplementation((async (p: string) => {
      calls += 1;
      // 1: file, 2: projects root (check), 3: the re-check of the file, which now names another inode.
      const result = await realRealpath(p);
      return calls === 3 ? path.join(path.dirname(result), 'b.html') : result;
    }) as typeof fs.realpath);
    try {
      const result = await readHtmlPreview(
        { containerPath: '/opt/projects/scratch/a.html' },
        roots,
      );
      expect(result).toEqual(OUTSIDE);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads from a host-folder project folder', async () => {
    const site = path.join(tmp, 'site');
    await fs.mkdir(site);
    await fs.writeFile(path.join(site, 'i.html'), '<b>site</b>');
    const withSite: PreviewRoots = {
      projectsRoot,
      hostFolders: [{ containerPath: '/opt/projects/site', hostPath: site }],
    };
    expect(await readHtmlPreview({ containerPath: '/opt/projects/site/i.html' }, withSite)).toEqual(
      {
        success: true,
        html: '<b>site</b>',
        name: 'i.html',
      },
    );
  });

  it('skips a root that does not exist', async () => {
    const result = await readHtmlPreview(
      { containerPath: '/opt/projects/scratch/d.html' },
      { projectsRoot: path.join(tmp, 'nope'), hostFolders: [] },
    );
    expect(result.success).toBe(false);
  });

  it('takes host-folder roots from the project store by default', async () => {
    const site = path.join(tmp, 'site');
    await fs.mkdir(site);
    await fs.writeFile(path.join(site, 'i.html'), 'stored');
    store.projects = [
      {
        id: 'a',
        kind: 'host-folder',
        containerPath: '/opt/projects/site',
        hostPath: site,
      },
      { id: 'b', kind: 'host-folder', hostPath: outside },
    ];
    expect(await readHtmlPreview({ containerPath: '/opt/projects/site/i.html' })).toMatchObject({
      success: true,
      html: 'stored',
    });
    expect(await readHtmlPreview({ containerPath: '/etc/x.html' })).toEqual(OUTSIDE);
  });
});
