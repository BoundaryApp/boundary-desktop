import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkReleaseNotes, findNotesFolders } from '../../../scripts/check-release-notes.mjs';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  releases?: { version: string; date: string }[];
  details?: Record<string, unknown>;
  guides?: Record<string, unknown>;
  images?: string[];
  boxes?: Record<string, unknown>;
}

/** Writes a content folder: `images` are paths like `0.0.1-rc.11/reactions`. */
function folder({ releases = [], details = {}, guides = {}, images = [], boxes = {} }: Fixture): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'));
  made.push(dir);
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(releases));
  for (const [version, detail] of Object.entries(details)) {
    mkdirSync(join(dir, version), { recursive: true });
    writeFileSync(join(dir, version, 'release.json'), JSON.stringify(detail));
  }
  for (const [id, guide] of Object.entries(guides)) {
    mkdirSync(join(dir, 'guides', id), { recursive: true });
    writeFileSync(join(dir, 'guides', id, 'guide.json'), JSON.stringify(guide));
  }
  for (const image of images) {
    mkdirSync(join(dir, image, '..'), { recursive: true });
    writeFileSync(join(dir, `${image}.png`), '');
  }
  for (const [image, box] of Object.entries(boxes)) {
    writeFileSync(join(dir, `${image}.json`), JSON.stringify(box));
  }
  return dir;
}

const slide = (image: string, extra: Record<string, unknown> = {}) => ({
  title: 'A feature',
  body: 'What it does.',
  image,
  ...extra,
});

const good = (): Fixture => ({
  releases: [
    { version: '0.0.1-rc.11', date: 'Nov 13' },
    { version: '0.0.1-rc.9', date: 'Nov 10' },
  ],
  details: {
    '0.0.1-rc.11': { slides: [slide('one', { guide: 'reactions' })], guides: [] },
    '0.0.1-rc.9': { slides: [slide('two')] },
  },
  guides: {
    reactions: {
      title: 'React to a message',
      minutes: 1,
      steps: [{ title: 'Hover', image: 'hover', callouts: [{ anchor: 'msg', text: 'Hover it.' }] }],
    },
  },
  images: ['0.0.1-rc.11/one', '0.0.1-rc.9/two', 'guides/reactions/hover'],
  boxes: { 'guides/reactions/hover': { msg: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } } },
});

const messages = (fixture: Fixture): string => checkReleaseNotes(folder(fixture)).join('\n');

describe('checkReleaseNotes', () => {
  it('passes a well-formed folder', () => {
    expect(checkReleaseNotes(folder(good()))).toEqual([]);
  });

  it('fails a release with seven slides', () => {
    const fixture = good();
    fixture.details!['0.0.1-rc.11'] = { slides: Array.from({ length: 7 }, () => slide('one')) };
    expect(messages(fixture)).toContain('at most 6 slides');
  });

  it('fails a slide whose guide id is missing', () => {
    const fixture = good();
    fixture.details!['0.0.1-rc.9'] = { slides: [slide('two', { guide: 'ghost' })] };
    expect(messages(fixture)).toContain('unknown guide');
  });

  it('fails a slide whose image is missing', () => {
    const fixture = good();
    fixture.images = fixture.images!.filter((image) => image !== '0.0.1-rc.9/two');
    expect(messages(fixture)).toContain('missing image');
  });

  it('fails a step whose image is missing', () => {
    const fixture = good();
    fixture.images = fixture.images!.filter((image) => image !== 'guides/reactions/hover');
    expect(messages(fixture)).toContain('missing image');
  });

  it('fails a callout whose anchor is absent from the sidecar', () => {
    const fixture = good();
    fixture.boxes = { 'guides/reactions/hover': { elsewhere: { x: 0, y: 0, w: 1, h: 1 } } };
    expect(messages(fixture)).toContain('unknown anchor');
  });

  it('fails releases.json that is not newest first', () => {
    const fixture = good();
    fixture.releases = [
      { version: '0.0.1-rc.9', date: 'Nov 10' },
      { version: '0.0.1-rc.11', date: 'Nov 13' },
    ];
    expect(messages(fixture)).toContain('newest first');
  });

  it('fails a folder with more than ten releases', () => {
    const fixture = good();
    fixture.releases = Array.from({ length: 11 }, (_, index) => ({
      version: `0.0.1-rc.${30 - index}`,
      date: 'Nov 13',
    }));
    expect(messages(fixture)).toContain('at most 10 releases');
  });

  it('fails a release folder that releases.json omits', () => {
    const fixture = good();
    fixture.releases = [{ version: '0.0.1-rc.11', date: 'Nov 13' }];
    expect(messages(fixture)).toContain('not listed');
  });

  it('passes a slide with no screenshot yet', () => {
    const fixture = good();
    fixture.details!['0.0.1-rc.9'] = { slides: [{ title: 'A feature', body: 'What it does.' }] };
    fixture.images = fixture.images!.filter((image) => image !== '0.0.1-rc.9/two');
    expect(checkReleaseNotes(folder(fixture))).toEqual([]);
  });

  it('fails a slide that rings an anchor without a screenshot', () => {
    const fixture = good();
    fixture.details!['0.0.1-rc.9'] = { slides: [{ title: 'A feature', body: 'What it does.', anchor: 'msg' }] };
    expect(messages(fixture)).toContain('needs a screenshot');
  });

  it('fails a guide with no steps', () => {
    const fixture = good();
    fixture.guides = { reactions: { title: 'React', minutes: 1, steps: [] } };
    expect(messages(fixture)).toContain('no steps');
  });

  it('fails a release with no slides', () => {
    const fixture = good();
    fixture.details!['0.0.1-rc.9'] = { slides: [] };
    expect(messages(fixture)).toContain('no slides');
  });

  it('passes a folder with no content at all', () => {
    expect(checkReleaseNotes(folder({}))).toEqual([]);
  });
});

describe('findNotesFolders', () => {
  function tree(paths: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'notes-tree-'));
    made.push(root);
    for (const path of paths) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, 'releases.json'), '[]');
    }
    return root;
  }

  it('finds the root folder and folders one level down, and skips dependencies and dot folders', () => {
    const root = tree(['whats-new', 'extra/whats-new', 'node_modules/whats-new', '.cache/whats-new', 'a/b/whats-new']);
    expect(findNotesFolders(root).sort()).toEqual([join(root, 'extra/whats-new'), join(root, 'whats-new')]);
  });

  it('skips a folder with no releases.json', () => {
    const root = tree([]);
    mkdirSync(join(root, 'whats-new'));
    expect(findNotesFolders(root)).toEqual([]);
  });
});
