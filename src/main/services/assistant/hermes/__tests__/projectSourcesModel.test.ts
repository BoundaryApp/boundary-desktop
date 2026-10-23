import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCatalog,
  buildNextStep,
  catalogIsFresh,
  globMatch,
  MANIFEST_NAME,
  parseIndexMarkdown,
  filterMountableContextRoots,
  parseSourcesYaml,
  refuseAddFolderReason,
  renderIndex,
  serializeSourcesYaml,
  shouldSkipRel,
  slugifySourceId,
  sourcesFromData,
  visibilityForSource,
  writeIndex,
  writeSourcesYamlToHub,
} from '../projectSourcesModel';

const temps: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sources.yaml parse/serialize', () => {
  it('defaults to hub-only when the mapping is empty', () => {
    expect(parseSourcesYaml('')).toEqual([
      {
        id: 'project',
        path: '.',
        retrieval: 'files',
        include: ['**/*.md', '**/*.txt'],
        exclude: [],
      },
    ]);
  });

  it('round-trips extra absolute paths and refuses reserved retrieval', () => {
    const text = serializeSourcesYaml([
      {
        id: 'project',
        path: '.',
        retrieval: 'files',
        include: ['**/*.md', '**/*.txt'],
        exclude: [],
      },
      {
        id: 'notes-vault',
        path: '/Users/you/Notes/this-project',
        retrieval: 'files',
        include: ['**/*.md'],
        exclude: ['.obsidian/**'],
      },
    ]);
    expect(text).toContain('path: "/Users/you/Notes/this-project"');
    expect(text).not.toContain('make context-root-add');
    expect(text).toContain('Add folder on the Sources rail');
    const parsed = parseSourcesYaml(text);
    expect(parsed.map((row) => row.id)).toEqual(['project', 'notes-vault']);
    expect(parsed[1]?.exclude).toEqual(['.obsidian/**']);
    expect(() =>
      sourcesFromData({
        version: 1,
        sources: [{ id: 'notes', path: '/tmp/notes', retrieval: 'lightrag' }],
      })
    ).toThrow(/not implemented/);
  });

  it('rejects invalid ids and versions', () => {
    expect(() =>
      sourcesFromData({ version: 2, sources: [{ id: 'project', path: '.' }] })
    ).toThrow(/unsupported/);
    expect(() =>
      sourcesFromData({
        version: 1,
        sources: [{ id: 'bad id', path: '.' }],
      })
    ).toThrow(/invalid source id/);
  });
});

describe('refuse and visibility', () => {
  it('refuses home, root, hub, and other library projects', () => {
    const home = '/Users/ada';
    const hub = '/Users/ada/Documents/Job Search';
    const other = '/Users/ada/Documents/Other';
    const lib = '/tmp/assistant/data/projects';
    expect(
      refuseAddFolderReason(home, {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
        libraryProjectsRoot: lib,
      })
    ).toBe('home');
    expect(
      refuseAddFolderReason('/', {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
      })
    ).toBe('root');
    expect(
      refuseAddFolderReason(hub, {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
      })
    ).toBe('hub');
    expect(
      refuseAddFolderReason(`${hub}/notes`, {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
      })
    ).toBe('under-hub');
    expect(
      refuseAddFolderReason(other, {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
      })
    ).toBe('library-project');
    expect(
      refuseAddFolderReason(`${lib}/scratch`, {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
        libraryProjectsRoot: lib,
      })
    ).toBe('library-project');
    expect(
      refuseAddFolderReason('/Users/ada/Notes/this-project', {
        home,
        hubPath: hub,
        otherProjectHostPaths: [other],
        libraryProjectsRoot: lib,
      })
    ).toBeNull();
  });

  it('does not treat host-folder remaps as coding roots', () => {
    const extra = '/Users/ada/Notes/this-project';
    expect(
      visibilityForSource(
        { id: 'notes-vault', path: extra, retrieval: 'files', include: [], exclude: [] },
        extra,
        '/Users/ada/Documents/Job Search',
        { contextRoots: [], codingRoots: [] }
      )
    ).toBe('unmounted');
    expect(
      visibilityForSource(
        { id: 'notes-vault', path: extra, retrieval: 'files', include: [], exclude: [] },
        extra,
        '/Users/ada/Documents/Job Search',
        { contextRoots: [extra], codingRoots: [] }
      )
    ).toBe('readonly');
    expect(
      visibilityForSource(
        { id: 'notes-vault', path: extra, retrieval: 'files', include: [], exclude: [] },
        extra,
        '/Users/ada/Documents/Job Search',
        { contextRoots: [], codingRoots: ['/Users/ada/Notes'] }
      )
    ).toBe('writable');
  });
});

describe('catalog and INDEX', () => {
  it('skips drafts and writes relative hub paths plus absolute extras', async () => {
    const hub = tmpDir('bd-src-hub-');
    const extra = tmpDir('bd-src-extra-');
    fs.mkdirSync(path.join(hub, 'notes'));
    fs.mkdirSync(path.join(hub, 'drafts'));
    fs.writeFileSync(path.join(hub, 'notes', 'resume.md'), '# Resume\n');
    fs.writeFileSync(path.join(hub, 'drafts', 'scratch.md'), '# Scratch\n');
    fs.writeFileSync(path.join(hub, 'AGENTS.md'), 'brief');
    fs.writeFileSync(path.join(extra, 'foo.md'), '---\ndescription: Vault note\n---\n# Foo\n');

    const sources = [
      {
        id: 'project',
        path: '.',
        retrieval: 'files' as const,
        include: ['**/*.md', '**/*.txt'],
        exclude: [],
      },
      {
        id: 'notes-vault',
        path: extra,
        retrieval: 'files' as const,
        include: ['**/*.md'],
        exclude: [],
      },
    ];
    const { files } = await buildCatalog(hub, sources);
    expect(files.map((row) => row.path)).toEqual([
      'notes/resume.md',
      path.resolve(extra, 'foo.md'),
    ]);
    expect(files[0]?.description).toBe('Resume');
    expect(files[1]?.description).toBe('Vault note');
    expect(shouldSkipRel('drafts/scratch.md')).toBe(true);
    expect(globMatch('notes/resume.md', '**/*.md')).toBe(true);

    await writeIndex(hub, sources, true);
    expect(await catalogIsFresh(hub, sources)).toBe(true);
    const rendered = fs.readFileSync(path.join(hub, 'INDEX.md'), 'utf8');
    expect(rendered).toContain('## project');
    expect(rendered).toContain('## notes-vault');
    expect(rendered).toContain('`notes/resume.md`');
    const parsed = parseIndexMarkdown(rendered);
    expect(parsed).toEqual([
      expect.objectContaining({
        sourceId: 'project',
        path: 'notes/resume.md',
        kind: 'relative',
      }),
      expect.objectContaining({
        sourceId: 'notes-vault',
        path: path.resolve(extra, 'foo.md'),
        kind: 'absolute',
      }),
    ]);

    fs.writeFileSync(path.join(hub, 'notes', 'cover.md'), '# Cover\n');
    expect(await catalogIsFresh(hub, sources)).toBe(false);
  });

  it('checks freshness from stats alone and hashes only files whose mtime moved', async () => {
    const hub = tmpDir('bd-src-fresh-');
    fs.mkdirSync(path.join(hub, 'notes'));
    const notes = ['a.md', 'b.md', 'c.md'].map((name) => path.join(hub, 'notes', name));
    for (const file of notes) fs.writeFileSync(file, `# ${path.basename(file)}\n`);
    const sources = [
      {
        id: 'project',
        path: '.',
        retrieval: 'files' as const,
        include: ['**/*.md'],
        exclude: [],
      },
    ];
    await writeIndex(hub, sources, false);

    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const createReadStream = vi.spyOn(fs, 'createReadStream');
    const readsOf = (file: string) =>
      [...readFileSync.mock.calls, ...readFile.mock.calls, ...createReadStream.mock.calls].filter(
        ([target]) => String(target) === file
      ).length;

    expect(await catalogIsFresh(hub, sources)).toBe(true);
    for (const file of notes) expect(readsOf(file)).toBe(0);
    expect(readFileSync).not.toHaveBeenCalled();

    // Touched without an edit: hashed once, still fresh; the others are still not read.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(notes[0]!, later, later);
    expect(await catalogIsFresh(hub, sources)).toBe(true);
    expect(readsOf(notes[0]!)).toBe(1);
    expect(readsOf(notes[1]!)).toBe(0);
    expect(readsOf(notes[2]!)).toBe(0);

    // Same size, different bytes, mtime moved: the hash catches it.
    fs.writeFileSync(notes[1]!, '# B.md\n');
    fs.utimesSync(notes[1]!, later, later);
    expect(await catalogIsFresh(hub, sources)).toBe(false);

    // A size change is stale without reading the file.
    fs.writeFileSync(notes[1]!, '# b.md\n');
    await writeIndex(hub, sources, false);
    for (const spy of [readFileSync, readFile, createReadStream]) spy.mockClear();
    fs.writeFileSync(notes[2]!, '# c.md, longer again\n');
    expect(await catalogIsFresh(hub, sources)).toBe(false);
    expect(readsOf(notes[2]!)).toBe(0);
  });

  it('shares one in-flight refresh per hub and leaves no temp files behind', async () => {
    const hub = tmpDir('bd-src-refresh-');
    fs.writeFileSync(path.join(hub, 'a.md'), '# A\n');
    const sources = [
      {
        id: 'project',
        path: '.',
        retrieval: 'files' as const,
        include: ['**/*.md'],
        exclude: [],
      },
    ];
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const first = writeIndex(hub, sources, false);
    const second = writeIndex(hub, sources, false);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(
      readFile.mock.calls.filter(([target]) => String(target) === path.join(hub, 'a.md'))
    ).toHaveLength(1);
    expect(fs.readdirSync(hub).sort()).toEqual([MANIFEST_NAME, 'INDEX.md', 'a.md'].sort());
    expect(await catalogIsFresh(hub, sources)).toBe(true);

    // Once it settles, the next refresh is a new run.
    const third = writeIndex(hub, sources, false);
    expect(third).not.toBe(first);
    await third;
  });

  it('renders an empty grouped table', () => {
    const text = renderIndex([], true);
    expect(text).toContain('no source markdown');
  });

  it('creates a missing hub directory before writing sources.yaml', () => {
    const parent = tmpDir('bd-src-parent-');
    const hub = path.join(parent, 'acme');
    expect(fs.existsSync(hub)).toBe(false);
    writeSourcesYamlToHub(hub, [
      {
        id: 'project',
        path: '.',
        retrieval: 'files',
        include: ['**/*.md', '**/*.txt'],
        exclude: [],
      },
      {
        id: 'notes',
        path: '/Users/ada/Notes',
        retrieval: 'files',
        include: ['**/*.md'],
        exclude: [],
      },
    ]);
    expect(fs.existsSync(path.join(hub, 'sources.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(hub, 'sources.yaml'), 'utf8')).toContain('notes');
  });
});

describe('next step and ids', () => {
  it('shows an in-app remount card before a ready state', () => {
    const step = buildNextStep(
      [
        {
          id: 'project',
          path: '.',
          hostPath: '/hub',
          retrieval: 'files',
          visibility: 'hub',
          isHub: true,
        },
        {
          id: 'notes-vault',
          path: '/Users/ada/Notes/this-project',
          hostPath: '/Users/ada/Notes/this-project',
          retrieval: 'files',
          visibility: 'unmounted',
          isHub: false,
        },
      ],
      true,
      'job-search'
    );
    expect(step?.tone).toBe('deny');
    expect(step?.title).toMatch(/isn’t visible/i);
    expect(step?.body).toMatch(/Remount/i);
    expect(step?.commands).toBeUndefined();
    expect(JSON.stringify(step)).not.toMatch(/make context-root-add|make project-index/);
  });

  it('points a stale index at Refresh index instead of Makefile', () => {
    const step = buildNextStep(
      [
        {
          id: 'project',
          path: '.',
          hostPath: '/hub',
          retrieval: 'files',
          visibility: 'hub',
          isHub: true,
        },
        {
          id: 'notes-vault',
          path: '/Users/ada/Notes/this-project',
          hostPath: '/Users/ada/Notes/this-project',
          retrieval: 'files',
          visibility: 'readonly',
          isHub: false,
        },
      ],
      true,
      'job-search'
    );
    expect(step?.tone).toBe('ok');
    expect(step?.title).toMatch(/behind the files/i);
    expect(step?.body).toMatch(/Refresh/);
    expect(step?.commands).toBeUndefined();
    expect(JSON.stringify(step)).not.toMatch(/make project-index/);
  });

  it('omits a Ready card when extras are visible and fresh', () => {
    const step = buildNextStep(
      [
        {
          id: 'project',
          path: '.',
          hostPath: '/hub',
          retrieval: 'files',
          visibility: 'hub',
          isHub: true,
        },
        {
          id: 'notes-vault',
          path: '/Users/ada/Notes/this-project',
          hostPath: '/Users/ada/Notes/this-project',
          retrieval: 'files',
          visibility: 'readonly',
          isHub: false,
        },
      ],
      false,
      'job-search'
    );
    expect(step).toBeUndefined();
  });

  it('omits home, root, and coding-covered paths from mountable extras', () => {
    const extra = tmpDir('bd-src-ctx-');
    const filtered = filterMountableContextRoots(
      ['/', os.homedir(), extra, extra, path.join(extra, 'missing')],
      {
        home: os.homedir(),
        codingRoots: [path.dirname(extra)],
        requireDirectory: true,
      }
    );
    expect(filtered).toEqual([]);
    const allowed = filterMountableContextRoots([extra, '/'], {
      home: os.homedir(),
      codingRoots: [],
      requireDirectory: true,
    });
    expect(allowed).toEqual([path.resolve(extra)]);
  });

  it('slugifies colliding source ids', () => {
    expect(slugifySourceId('this-project', ['this-project'])).toBe('this-project-2');
  });
});
