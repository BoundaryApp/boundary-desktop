import fs from 'node:fs';
import path from 'node:path';
import type {
  WritingVoiceActionResult,
  WritingVoiceCheckSummary,
  WritingVoiceCreatePayload,
  WritingVoiceCreateResult,
  WritingVoiceRecord,
  WritingVoiceSamplesResult,
  WritingVoiceSampleCheck,
  WritingVoiceSource,
  WritingVoiceView,
  WritingVoiceViewResult,
} from '../../../../shared/types/writingVoices';
import { BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE } from '../../../../shared/assistantStackConstants';
import { slugify, uniqueSlug } from '../../../../shared/utils/slug';
import { persistDebugLog } from '../../../persistDebugLog';
import { resolveActiveAssistantRoot } from '../resolveAssistantRoot';
import {
  isWritingVoiceCalibrating,
  resetInterruptedCalibrations,
  writingVoiceStep,
} from './writingVoiceCalibration';
import {
  hashWritingVoiceSamples,
  listWritingVoiceFiles,
  writingVoiceDir,
  writingVoiceRoot,
} from './writingVoicePaths';
import { checkWritingVoiceSamples } from './writingVoiceSamples';
import {
  listWritingVoiceRecords,
  removeWritingVoiceRecord,
  upsertWritingVoiceRecord,
} from './writingVoiceStore';
import { readWritingVoiceStyle, writeNeverDoes } from './writingVoiceStyle';

export { hashWritingVoiceSamples, writingVoiceDir } from './writingVoicePaths';

const MAX_NAME_LENGTH = 60;

type Deps = { contentRoot?: string };

/** Names and ids of creates still running, so two at once can't pick the same id or folder. */
const creatingNames = new Set<string>();
const creatingIds = new Set<string>();

/** A slug for the voice's folder, skipping ids already taken by records or folders. */
export function writingVoiceId(name: string, taken: Set<string>): string {
  return uniqueSlug(slugify(name, { fallback: 'voice' }), taken);
}

function uniqueName(name: string, used: Set<string>): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/** A trimmed name, or why it can't be used. `self` is the voice being renamed. */
function checkName(raw: string, self?: string): { name: string } | { error: string } {
  const name = raw.trim();
  if (!name) return { error: 'Give the voice a name.' };
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `Use a name of ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  const clash = listWritingVoiceRecords().find(
    (v) => v.id !== self && v.name.toLowerCase() === name.toLowerCase()
  );
  return clash ? { error: `A voice called ${clash.name} already exists.` } : { name };
}

/** Copy used samples into `samplesDir`, never over a file already there. */
async function copySamples(used: WritingVoiceSampleCheck[], samplesDir: string): Promise<void> {
  const names = new Set(
    (await fs.promises.readdir(samplesDir).catch((): string[] => [])).map((n) => n.toLowerCase())
  );
  let pasted = 0;
  for (const sample of used) {
    if (sample.source.kind === 'pasted') {
      pasted += 1;
      const target = uniqueName(`pasted-text-${pasted}.md`, names);
      await fs.promises.writeFile(path.join(samplesDir, target), sample.source.text, 'utf8');
    } else {
      const target = uniqueName(path.basename(sample.source.path), names);
      await fs.promises.copyFile(sample.source.path, path.join(samplesDir, target));
    }
  }
}

function getRecord(id: string): WritingVoiceRecord | null {
  return listWritingVoiceRecords().find((v) => v.id === id) ?? null;
}

async function toView(record: WritingVoiceRecord, deps: Deps): Promise<WritingVoiceView> {
  const dir = writingVoiceDir(record.id, deps.contentRoot);
  const hash = await hashWritingVoiceSamples(path.join(dir, 'samples')).catch((): null => null);
  return {
    ...record,
    style: await readWritingVoiceStyle(dir),
    samplesChanged: record.status === 'ready' && hash !== null && hash !== record.sampleHash,
    step: writingVoiceStep(record.id),
  };
}

export async function listWritingVoiceViews(deps: Deps = {}): Promise<WritingVoiceView[]> {
  resetInterruptedCalibrations();
  return Promise.all(listWritingVoiceRecords().map((record) => toView(record, deps)));
}

export async function createWritingVoice(
  payload: WritingVoiceCreatePayload,
  deps: Deps & { now?: () => Date } = {}
): Promise<WritingVoiceCreateResult> {
  const checked = checkName(payload.name);
  if ('error' in checked) return { success: false, error: checked.error };
  const { name } = checked;
  const nameKey = name.toLowerCase();
  if (creatingNames.has(nameKey)) {
    return { success: false, error: `A voice called ${name} is already being created.` };
  }
  creatingNames.add(nameKey);
  try {
    return await createWritingVoiceNamed(name, payload, deps);
  } finally {
    creatingNames.delete(nameKey);
  }
}

async function createWritingVoiceNamed(
  name: string,
  payload: WritingVoiceCreatePayload,
  deps: Deps & { now?: () => Date }
): Promise<WritingVoiceCreateResult> {
  // Before setup, the stack's folder doesn't exist yet; making data/ there would send the first
  // install down the upgrade path.
  if (
    !deps.contentRoot &&
    !fs.existsSync(path.join(resolveActiveAssistantRoot(), BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE))
  ) {
    return { success: false, error: 'Set up the assistant before creating a voice.' };
  }
  const summary = await checkWritingVoiceSamples(payload.sources);
  const used = summary.files.filter((f) => f.refused === null);
  if (used.length === 0) {
    return { success: false, error: 'Add at least one sample in a text format.' };
  }

  const root = writingVoiceRoot(deps.contentRoot);
  await fs.promises.mkdir(root, { recursive: true });
  // Lowercased: the Mac's file system treats Mine/ and mine/ as one folder.
  const taken = new Set(
    [...listWritingVoiceRecords().map((v) => v.id), ...(await fs.promises.readdir(root)), ...creatingIds].map(
      (n) => n.toLowerCase()
    )
  );
  const id = writingVoiceId(name, taken);
  creatingIds.add(id);
  try {
    return await createWritingVoiceFolder(id, name, summary, used, root, deps);
  } finally {
    creatingIds.delete(id);
  }
}

async function createWritingVoiceFolder(
  id: string,
  name: string,
  summary: WritingVoiceCheckSummary,
  used: WritingVoiceSampleCheck[],
  root: string,
  deps: Deps & { now?: () => Date }
): Promise<WritingVoiceCreateResult> {
  const started = Date.now();
  const staging = path.join(root, `.${id}.creating`);
  const samples = path.join(staging, 'samples');
  try {
    // A create that crashed part way leaves this folder behind; its files aren't this voice's.
    await fs.promises.rm(staging, { recursive: true, force: true });
    await fs.promises.mkdir(samples, { recursive: true });
    await copySamples(used, samples);
    const record: WritingVoiceRecord = {
      id,
      name,
      status: 'not-calibrated',
      pieces: summary.pieces,
      words: summary.words,
      createdAt: (deps.now ?? (() => new Date()))().toISOString(),
      calibratedAt: null,
      sampleHash: await hashWritingVoiceSamples(samples),
    };
    await fs.promises.rename(staging, path.join(root, id));
    upsertWritingVoiceRecord(record);
    persistDebugLog('writing-voices', 'created', {
      id,
      pieces: record.pieces,
      words: record.words,
      ms: Date.now() - started,
    });
    return { success: true, voice: record };
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true });
    persistDebugLog('writing-voices', 'create failed', {
      id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { success: false, error: 'The voice could not be saved. Nothing was kept.' };
  }
}

const NO_VOICE = { success: false as const, error: 'No such voice.' };

async function sampleChecks(id: string, deps: Deps) {
  const samples = path.join(writingVoiceDir(id, deps.contentRoot), 'samples');
  const files = await listWritingVoiceFiles(samples);
  const summary = await checkWritingVoiceSamples(
    files.map((f) => ({ kind: 'file' as const, path: path.join(samples, f.rel) }))
  );
  return { samples, files, summary };
}

/** Recount pieces and words from the folder and save them. */
async function recount(record: WritingVoiceRecord, deps: Deps): Promise<WritingVoiceView> {
  const { summary } = await sampleChecks(record.id, deps);
  const next = { ...record, pieces: summary.pieces, words: summary.words };
  upsertWritingVoiceRecord(next);
  return toView(next, deps);
}

export async function listWritingVoiceSamples(id: string, deps: Deps = {}): Promise<WritingVoiceSamplesResult> {
  if (!getRecord(id)) return NO_VOICE;
  const { summary, files } = await sampleChecks(id, deps);
  return {
    success: true,
    files: summary.files.map((f, i) => ({ name: files[i].rel, words: f.words })),
  };
}

export async function addWritingVoiceSamples(
  id: string,
  sources: WritingVoiceSource[],
  deps: Deps = {}
): Promise<WritingVoiceViewResult> {
  const record = getRecord(id);
  if (!record) return NO_VOICE;
  const used = (await checkWritingVoiceSamples(sources)).files.filter((f) => f.refused === null);
  if (used.length === 0) return { success: false, error: 'Add at least one sample in a text format.' };
  const samples = path.join(writingVoiceDir(id, deps.contentRoot), 'samples');
  await fs.promises.mkdir(samples, { recursive: true });
  await copySamples(used, samples);
  const voice = await recount(record, deps);
  persistDebugLog('writing-voices', 'samples added', { id, added: used.length, pieces: voice.pieces, words: voice.words });
  return { success: true, voice };
}

export async function removeWritingVoiceSample(
  id: string,
  name: string,
  deps: Deps = {}
): Promise<WritingVoiceViewResult> {
  const record = getRecord(id);
  if (!record) return NO_VOICE;
  const { samples, files } = await sampleChecks(id, deps);
  if (!files.some((f) => f.rel === name)) return { success: false, error: 'No such sample.' };
  if (files.length <= 1) return { success: false, error: 'A voice needs at least one sample.' };
  await fs.promises.rm(path.join(samples, name));
  const voice = await recount(record, deps);
  persistDebugLog('writing-voices', 'sample removed', { id, pieces: voice.pieces, words: voice.words });
  return { success: true, voice };
}

export async function renameWritingVoice(id: string, raw: string, deps: Deps = {}): Promise<WritingVoiceViewResult> {
  const record = getRecord(id);
  if (!record) return NO_VOICE;
  const checked = checkName(raw, id);
  if ('error' in checked) return { success: false, error: checked.error };
  const next = { ...record, name: checked.name };
  upsertWritingVoiceRecord(next);
  return { success: true, voice: await toView(next, deps) };
}

export async function setWritingVoiceNeverDoes(
  id: string,
  lines: string[],
  deps: Deps = {}
): Promise<WritingVoiceViewResult> {
  const record = getRecord(id);
  if (!record) return NO_VOICE;
  const written = await writeNeverDoes(writingVoiceDir(id, deps.contentRoot), lines);
  if ('error' in written) return { success: false, error: written.error };
  return { success: true, voice: await toView(record, deps) };
}

/** Move the voice's folder to the Trash, then forget it (ADR 0056 §10). */
export async function deleteWritingVoice(
  id: string,
  deps: Deps & { trash: (folder: string) => Promise<void>; calibrating?: (id: string) => boolean }
): Promise<WritingVoiceActionResult> {
  if (!getRecord(id)) return NO_VOICE;
  if ((deps.calibrating ?? isWritingVoiceCalibrating)(id)) {
    return { success: false, error: 'Wait for calibration to finish.' };
  }
  const dir = writingVoiceDir(id, deps.contentRoot);
  try {
    if (fs.existsSync(dir)) await deps.trash(dir);
  } catch {
    return { success: false, error: "The voice's folder couldn't be moved to the Trash." };
  }
  removeWritingVoiceRecord(id);
  persistDebugLog('writing-voices', 'deleted', { id });
  return { success: true };
}
