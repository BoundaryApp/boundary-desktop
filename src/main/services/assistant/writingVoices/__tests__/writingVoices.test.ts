import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  storeData: {} as Record<string, unknown>,
  copyFails: null as null | ((n: number) => boolean),
  copies: 0,
}));

vi.mock('electron-store', () => ({
  default: class {
    constructor(opts: { defaults: Record<string, unknown> }) {
      for (const [k, v] of Object.entries(opts.defaults)) {
        if (!(k in h.storeData)) h.storeData[k] = structuredClone(v);
      }
    }
    get(key: string) {
      return structuredClone(h.storeData[key]);
    }
    set(key: string, value: unknown) {
      h.storeData[key] = structuredClone(value);
    }
  },
}));

vi.mock('../../assistantStackIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../assistantStackIdentity')>()),
  activeAssistantStackIdentity: () => ({ kind: 'managed', root: '/stack' }),
}));

vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

const active = vi.hoisted(() => ({ root: '' }));
vi.mock('../../resolveAssistantRoot', () => ({ resolveActiveAssistantRoot: () => active.root }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const copyFile = async (...args: Parameters<typeof real.promises.copyFile>) => {
    h.copies += 1;
    if (h.copyFails?.(h.copies)) throw new Error('disk full');
    return real.promises.copyFile(...args);
  };
  const promises = { ...real.promises, copyFile };
  return { ...real, default: { ...real, promises }, promises };
});

import { writingVoicesStoreName } from '../../assistantStackIdentity';
import { persistDebugLog } from '../../../../persistDebugLog';
import type { WritingVoiceRecord } from '../../../../../shared/types/writingVoices';
import {
  isWritingVoiceCalibrationSession,
  listWritingVoiceRecords,
  resetWritingVoiceStoreForTests,
  upsertWritingVoiceRecord,
} from '../writingVoiceStore';
import {
  addWritingVoiceSamples,
  createWritingVoice,
  deleteWritingVoice,
  hashWritingVoiceSamples,
  listWritingVoiceSamples,
  listWritingVoiceViews,
  removeWritingVoiceSample,
  renameWritingVoice,
  setWritingVoiceNeverDoes,
  writingVoiceDir,
  writingVoiceId,
} from '../writingVoices';

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('writingVoicesStoreName', () => {
  it('names a store per stack', () => {
    expect(writingVoicesStoreName({ kind: 'managed', root: '/x' })).toBe('writing-voices-managed');
    expect(writingVoicesStoreName({ kind: 'local', root: '/x' })).toMatch(
      /^writing-voices-local-[0-9a-f]{12}$/
    );
  });
});

describe('writingVoiceId', () => {
  it('makes a slug and skips taken ones', () => {
    expect(writingVoiceId('Company Blog!', new Set())).toBe('company-blog');
    expect(writingVoiceId('Company Blog', new Set(['company-blog']))).toBe('company-blog-2');
    expect(writingVoiceId('!!!', new Set())).toBe('voice');
    expect(writingVoiceId('  Zoë’s Notes ', new Set())).toBe('zo-s-notes');
    expect(writingVoiceId('a'.repeat(60), new Set())).toBe('a'.repeat(60));
  });
});

describe('createWritingVoice', () => {
  let root: string;
  let src: string;
  const now = () => new Date('2026-11-11T12:00:00Z');
  const file = (rel: string, body: string) => {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    h.storeData = {};
    h.copyFails = null;
    h.copies = 0;
    resetWritingVoiceStoreForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-root-'));
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-src-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('copies used samples into the voice folder and saves a record', async () => {
    const a = file('a.md', words(600));
    const b = file('b.txt', words(100));
    const c = file('c.pdf', 'x');
    const result = await createWritingVoice(
      {
        name: '  Field notes ',
        sources: [
          { kind: 'file', path: a },
          { kind: 'file', path: b },
          { kind: 'file', path: c },
          { kind: 'pasted', text: words(50) },
        ],
      },
      { contentRoot: root, now }
    );
    expect(result).toMatchObject({
      success: true,
      voice: {
        id: 'field-notes',
        name: 'Field notes',
        status: 'not-calibrated',
        pieces: 3,
        words: 750,
        calibratedAt: null,
        createdAt: '2026-11-11T12:00:00.000Z',
      },
    });
    const samples = path.join(writingVoiceDir('field-notes', root), 'samples');
    expect(fs.readdirSync(samples).sort()).toEqual(['a.md', 'b.txt', 'pasted-text-1.md']);
    expect(listWritingVoiceRecords().map((v) => v.id)).toEqual(['field-notes']);
  });

  it('refuses a second create of the same name while the first runs', async () => {
    const a = file('a.md', words(20));
    const payload = { name: 'Notes', sources: [{ kind: 'file' as const, path: a }] };
    const [first, second] = await Promise.all([
      createWritingVoice(payload, { contentRoot: root, now }),
      createWritingVoice({ ...payload, name: 'notes' }, { contentRoot: root, now }),
    ]);
    expect(first).toMatchObject({ success: true, voice: { id: 'notes' } });
    expect(second).toEqual({ success: false, error: 'A voice called notes is already being created.' });
    expect(listWritingVoiceRecords().map((v) => v.id)).toEqual(['notes']);
  });

  it('gives two running creates whose names share a slug their own folders', async () => {
    const a = file('a.md', words(20));
    const b = file('b.md', words(30));
    const [one, two] = await Promise.all([
      createWritingVoice({ name: 'Field notes', sources: [{ kind: 'file', path: a }] }, { contentRoot: root, now }),
      createWritingVoice({ name: 'Field, notes', sources: [{ kind: 'file', path: b }] }, { contentRoot: root, now }),
    ]);
    // Either may reach the id first; each gets its own folder with only its own sample.
    if (!one.success || !two.success) throw new Error('both creates should succeed');
    expect([one.voice.id, two.voice.id].sort()).toEqual(['field-notes', 'field-notes-2']);
    expect(fs.readdirSync(path.join(writingVoiceDir(one.voice.id, root), 'samples'))).toEqual(['a.md']);
    expect(fs.readdirSync(path.join(writingVoiceDir(two.voice.id, root), 'samples'))).toEqual(['b.md']);
  });

  it('keeps both files when two have the same name', async () => {
    const one = file('x/notes.md', 'first');
    const two = file('y/notes.md', 'second');
    const result = await createWritingVoice(
      { name: 'Notes', sources: [{ kind: 'file', path: one }, { kind: 'file', path: two }] },
      { contentRoot: root, now }
    );
    expect(result.success).toBe(true);
    const samples = path.join(writingVoiceDir('notes', root), 'samples');
    expect(fs.readFileSync(path.join(samples, 'notes.md'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(samples, 'notes (2).md'), 'utf8')).toBe('second');
  });

  it('refuses a blank or long name', async () => {
    const sources = [{ kind: 'pasted' as const, text: 'some words' }];
    expect(await createWritingVoice({ name: ' ', sources }, { contentRoot: root })).toEqual({
      success: false,
      error: 'Give the voice a name.',
    });
    expect(
      await createWritingVoice({ name: 'x'.repeat(61), sources }, { contentRoot: root })
    ).toEqual({ success: false, error: 'Use a name of 60 characters or fewer.' });
  });

  it('refuses a name another voice has in any case', async () => {
    upsertWritingVoiceRecord({
      id: 'newsletter',
      name: 'Newsletter',
      status: 'ready',
      pieces: 1,
      words: 1,
      createdAt: '',
      calibratedAt: null,
      sampleHash: '',
    });
    const result = await createWritingVoice(
      { name: 'newsletter', sources: [{ kind: 'pasted', text: 'words here' }] },
      { contentRoot: root }
    );
    expect(result).toEqual({ success: false, error: 'A voice called Newsletter already exists.' });
  });

  it('refuses when no sample can be used', async () => {
    const c = file('c.pdf', 'x');
    const result = await createWritingVoice(
      { name: 'Empty', sources: [{ kind: 'file', path: c }] },
      { contentRoot: root }
    );
    expect(result).toEqual({ success: false, error: 'Add at least one sample in a text format.' });
  });

  it('leaves a folder it did not make alone and picks another id', async () => {
    const existing = path.join(writingVoiceDir('field-notes', root), 'samples');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'mine.md'), 'hand made');
    const result = await createWritingVoice(
      { name: 'Field notes', sources: [{ kind: 'pasted', text: 'words here' }] },
      { contentRoot: root }
    );
    expect(result).toMatchObject({ success: true, voice: { id: 'field-notes-2' } });
    expect(fs.readdirSync(existing)).toEqual(['mine.md']);
  });

  it('starts from an empty folder when an earlier create crashed part way', async () => {
    const stale = path.join(root, 'voice', '.crash.creating', 'samples');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'stale.md'), 'left over');
    const result = await createWritingVoice(
      { name: 'Crash', sources: [{ kind: 'pasted', text: 'fresh words' }] },
      { contentRoot: root }
    );
    expect(result).toMatchObject({ success: true, voice: { id: 'crash' } });
    expect(fs.readdirSync(path.join(writingVoiceDir('crash', root), 'samples'))).toEqual([
      'pasted-text-1.md',
    ]);
  });

  it('treats a folder whose name differs only in case as taken', async () => {
    const mine = path.join(root, 'voice', 'Mine');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'keep.md'), 'theirs');
    fs.mkdirSync(path.join(root, 'voice', 'Empty'));
    const sources = [{ kind: 'pasted' as const, text: 'some words' }];
    expect(await createWritingVoice({ name: 'mine', sources }, { contentRoot: root })).toMatchObject({
      success: true,
      voice: { id: 'mine-2' },
    });
    expect(await createWritingVoice({ name: 'empty', sources }, { contentRoot: root })).toMatchObject({
      success: true,
      voice: { id: 'empty-2' },
    });
    expect(fs.readdirSync(mine)).toEqual(['keep.md']);
    expect(fs.readdirSync(path.join(root, 'voice', 'Empty'))).toEqual([]);
  });

  it('leaves no record or folder when a copy fails', async () => {
    const a = file('a.md', words(10));
    const b = file('b.md', words(10));
    h.copyFails = (n) => n === 2;
    const result = await createWritingVoice(
      { name: 'Broken', sources: [{ kind: 'file', path: a }, { kind: 'file', path: b }] },
      { contentRoot: root }
    );
    expect(result.success).toBe(false);
    expect(listWritingVoiceRecords()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'voice'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'voice'))).toEqual([]);
  });
});

describe('createWritingVoice on the active stack', () => {
  let stack: string;
  beforeEach(() => {
    h.storeData = {};
    h.copyFails = null;
    resetWritingVoiceStoreForTests();
    stack = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-stack-'));
    active.root = stack;
  });
  afterEach(() => fs.rmSync(stack, { recursive: true, force: true }));

  it('writes into the active stack\'s data folder', async () => {
    fs.writeFileSync(path.join(stack, 'docker-compose.yml'), 'services: {}');
    const result = await createWritingVoice({
      name: 'Local',
      sources: [{ kind: 'pasted', text: 'some words' }],
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(stack, 'data', 'voice', 'local', 'samples', 'pasted-text-1.md'))).toBe(true);
  });

  it('refuses before the stack is set up and writes nothing', async () => {
    const result = await createWritingVoice({
      name: 'Early',
      sources: [{ kind: 'pasted', text: 'some words' }],
    });
    expect(result).toEqual({
      success: false,
      error: 'Set up the assistant before creating a voice.',
    });
    expect(fs.readdirSync(stack)).toEqual([]);
    expect(listWritingVoiceRecords()).toEqual([]);
  });
});

describe('hashWritingVoiceSamples', () => {
  it('changes when a file is added and ignores listing order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-hash-'));
    fs.writeFileSync(path.join(dir, 'b.md'), 'bb');
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    const first = await hashWritingVoiceSamples(dir);
    expect(await hashWritingVoiceSamples(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'finder');
    expect(await hashWritingVoiceSamples(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'c.md'), 'c');
    expect(await hashWritingVoiceSamples(dir)).not.toBe(first);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('voice operations', () => {
  let root: string;
  const STYLE = '---\ncalibrated: 2026-11-11\nexemplars:\n  - samples/a.md\n---\n\n# Voice: ops\n\nPlain and short.\n\n## Never does\n\n- Never shouts\n';
  const dir = () => writingVoiceDir('ops', root);
  const samples = () => path.join(dir(), 'samples');

  async function makeOps(status: WritingVoiceRecord['status'] = 'ready') {
    fs.mkdirSync(samples(), { recursive: true });
    fs.writeFileSync(path.join(samples(), 'a.md'), words(20));
    fs.writeFileSync(path.join(samples(), 'b.md'), words(30));
    fs.writeFileSync(path.join(dir(), 'STYLE.md'), STYLE);
    upsertWritingVoiceRecord({
      id: 'ops',
      name: 'Ops',
      status,
      pieces: 2,
      words: 50,
      createdAt: '',
      calibratedAt: '2026-11-11T00:00:00.000Z',
      sampleHash: await hashWritingVoiceSamples(samples()),
      calibrationSessionIds: ['stored-calibration'],
    });
  }

  beforeEach(() => {
    h.storeData = {};
    h.copyFails = null;
    resetWritingVoiceStoreForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-ops-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists views with the style guide and notices changed samples', async () => {
    await makeOps();
    let [view] = await listWritingVoiceViews({ contentRoot: root });
    expect(view.style?.description).toBe('Plain and short.');
    expect(view.samplesChanged).toBe(false);
    fs.writeFileSync(path.join(samples(), 'c.md'), 'new');
    [view] = await listWritingVoiceViews({ contentRoot: root });
    expect(view.samplesChanged).toBe(true);
  });

  it('lists samples with their words', async () => {
    await makeOps();
    expect(await listWritingVoiceSamples('ops', { contentRoot: root })).toEqual({
      success: true,
      files: [
        { name: 'a.md', words: 20 },
        { name: 'b.md', words: 30 },
      ],
    });
  });

  it('adds samples under unique names and updates the counts', async () => {
    await makeOps();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-add-'));
    fs.writeFileSync(path.join(src, 'a.md'), words(40));
    const result = await addWritingVoiceSamples('ops', [{ kind: 'file', path: path.join(src, 'a.md') }], {
      contentRoot: root,
    });
    expect(result).toMatchObject({ success: true, voice: { pieces: 3, words: 90, samplesChanged: true } });
    expect(fs.readdirSync(samples()).sort()).toEqual(['a (2).md', 'a.md', 'b.md']);
    // Counts only: never the file names it copied.
    expect(vi.mocked(persistDebugLog)).toHaveBeenCalledWith('writing-voices', 'samples added', {
      id: 'ops',
      added: 1,
      pieces: 3,
      words: 90,
    });
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('removes a sample but never the last one or one outside the folder', async () => {
    await makeOps();
    expect(await removeWritingVoiceSample('ops', '../STYLE.md', { contentRoot: root })).toEqual({
      success: false,
      error: 'No such sample.',
    });
    expect(await removeWritingVoiceSample('ops', 'b.md', { contentRoot: root })).toMatchObject({
      success: true,
      voice: { pieces: 1, words: 20 },
    });
    expect(await removeWritingVoiceSample('ops', 'a.md', { contentRoot: root })).toEqual({
      success: false,
      error: 'A voice needs at least one sample.',
    });
    expect(fs.existsSync(path.join(dir(), 'STYLE.md'))).toBe(true);
    expect(vi.mocked(persistDebugLog)).toHaveBeenCalledWith('writing-voices', 'sample removed', {
      id: 'ops',
      pieces: 1,
      words: 20,
    });
  });

  it('renames with the same rules as create and keeps the folder', async () => {
    await makeOps();
    upsertWritingVoiceRecord({ ...listWritingVoiceRecords()[0], id: 'other', name: 'Other' });
    expect(await renameWritingVoice('ops', 'other', { contentRoot: root })).toEqual({
      success: false,
      error: 'A voice called Other already exists.',
    });
    expect(await renameWritingVoice('ops', ' Field notes ', { contentRoot: root })).toMatchObject({
      success: true,
      voice: { id: 'ops', name: 'Field notes' },
    });
  });

  it('saves Never does through STYLE.md', async () => {
    await makeOps();
    expect(await setWritingVoiceNeverDoes('ops', ['Never hedges'], { contentRoot: root })).toMatchObject({
      success: true,
      voice: { style: { neverDoes: ['Never hedges'] } },
    });
  });

  it('moves the folder to the Trash before forgetting the voice', async () => {
    await makeOps();
    const trashed: string[] = [];
    expect(
      await deleteWritingVoice('ops', {
        contentRoot: root,
        trash: async () => {
          throw new Error('no');
        },
      })
    ).toEqual({ success: false, error: "The voice's folder couldn't be moved to the Trash." });
    expect(listWritingVoiceRecords()).toHaveLength(1);
    expect(
      await deleteWritingVoice('ops', { contentRoot: root, trash: async (p) => void trashed.push(p) })
    ).toEqual({ success: true });
    expect(trashed).toEqual([dir()]);
    expect(listWritingVoiceRecords()).toEqual([]);
    expect(isWritingVoiceCalibrationSession('stored-calibration')).toBe(true);
  });

  it('refuses to delete while calibrating', async () => {
    await makeOps('calibrating');
    expect(
      await deleteWritingVoice('ops', { contentRoot: root, trash: async () => undefined, calibrating: () => true })
    ).toEqual({ success: false, error: 'Wait for calibration to finish.' });
  });

  it('knows its calibration sessions', async () => {
    await makeOps();
    expect(isWritingVoiceCalibrationSession('stored-calibration')).toBe(true);
    expect(isWritingVoiceCalibrationSession('a-chat')).toBe(false);
  });
});
