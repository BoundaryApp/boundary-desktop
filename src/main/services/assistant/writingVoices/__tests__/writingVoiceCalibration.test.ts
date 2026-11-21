import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritingVoiceProgress, WritingVoiceRecord } from '../../../../../shared/types/writingVoices';

const h = vi.hoisted(() => ({ storeData: {} as Record<string, unknown> }));

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

import {
  calibrateWritingVoice,
  resetInterruptedCalibrations,
  writingVoiceCalibrationPrompt,
  type CalibrationGateway,
} from '../writingVoiceCalibration';
import {
  listWritingVoiceRecords,
  resetWritingVoiceStoreForTests,
  upsertWritingVoiceRecord,
} from '../writingVoiceStore';
import { writingVoiceDir } from '../writingVoices';

const MIN = 60_000;

type Handler = (event: { session_id?: string; payload?: unknown }) => void;

function fakeGateway(over: Partial<CalibrationGateway> = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const waiters: Array<() => void> = [];
  let n = 0;
  const gateway = {
    submitted: [] as Array<{ id: string; text: string }>,
    cancelled: [] as string[],
    created: 0,
    ready: vi.fn(async () => true),
    gate: vi.fn(async () => ({ ok: true as const })),
    createSession: vi.fn(async () => {
      gateway.created += 1;
      n += 1;
      return { id: `rt-${n}`, storedId: `st-${n}` };
    }),
    submit: vi.fn(async (id: string, text: string) => {
      gateway.submitted.push({ id, text });
      for (const w of waiters.splice(0)) w();
    }),
    /** Resolves once `n` prompts have been submitted; calibration reads files before it submits. */
    untilSubmitted: (count: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const check = () => (gateway.submitted.length >= count ? resolve() : waiters.push(check));
        check();
      }),
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => handlers.get(event)!.delete(handler);
    },
    liveStatus: vi.fn(async () => 'running' as string | null),
    cancel: vi.fn(async (id: string) => {
      gateway.cancelled.push(id);
    }),
    emit(event: string, sessionId: string, payload: unknown = {}) {
      for (const handler of handlers.get(event) ?? []) handler({ session_id: sessionId, payload });
    },
    ...over,
  };
  return gateway;
}

const STYLE = `---
calibrated: 2026-11-11
exemplars:
  - samples/a.md
---

# Voice: v

Plain.

## Never does

- Never shouts
`;

let root: string;
const record = (over: Partial<WritingVoiceRecord> = {}): WritingVoiceRecord => ({
  id: 'v',
  name: 'V',
  status: 'not-calibrated',
  pieces: 1,
  words: 10,
  createdAt: '',
  calibratedAt: null,
  sampleHash: 'old',
  ...over,
});

function makeVoice(id = 'v') {
  const samples = path.join(writingVoiceDir(id, root), 'samples');
  fs.mkdirSync(samples, { recursive: true });
  fs.writeFileSync(path.join(samples, 'a.md'), 'some words');
  upsertWritingVoiceRecord(record({ id, name: id.toUpperCase() }));
}

const writeStyle = (id = 'v') => fs.writeFileSync(path.join(writingVoiceDir(id, root), 'STYLE.md'), STYLE);
const stored = (id = 'v') => listWritingVoiceRecords().find((v) => v.id === id)!;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
  h.storeData = {};
  resetWritingVoiceStoreForTests();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-cal-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('calibrateWritingVoice', () => {
  it('runs one hidden turn and marks the voice ready when STYLE.md checks out', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const steps: WritingVoiceProgress[] = [];
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root, onProgress: (p) => steps.push(p) });
    await gateway.untilSubmitted(1);
    expect(gateway.submitted).toEqual([{ id: 'rt-1', text: writingVoiceCalibrationPrompt('v') }]);
    gateway.emit('tool.start', 'other', { name: 'write_file' });
    gateway.emit('tool.start', 'rt-1', { name: 'terminal' });
    gateway.emit('tool.start', 'rt-1', { name: 'write_file' });
    writeStyle();
    gateway.emit('message.complete', 'rt-1', { status: 'complete' });
    const voice = await done;
    expect(steps.map((p) => p.step)).toEqual(['starting', 'reading', 'writing', 'checking', null]);
    expect(voice).toMatchObject({
      status: 'ready',
      calibratedAt: '2026-11-11T12:00:00.000Z',
      lastError: null,
      calibrationSessionIds: ['st-1'],
    });
    expect(voice.sampleHash).not.toBe('old');
    expect(stored().status).toBe('ready');
  });

  it('is not ready when the turn ends without a usable STYLE.md', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    gateway.emit('message.complete', 'rt-1', { status: 'complete' });
    expect(await done).toMatchObject({
      status: 'not-calibrated',
      lastError: 'Calibration ended without a usable style guide.',
    });
  });

  it('asks for the assistant to be started and opens no session', async () => {
    makeVoice();
    const gateway = fakeGateway({ ready: vi.fn(async () => false) });
    expect(await calibrateWritingVoice('v', { gateway, contentRoot: root })).toMatchObject({
      status: 'not-calibrated',
      lastError: 'Start the assistant first.',
    });
    expect(gateway.created).toBe(0);
  });

  it('passes on the model gate refusal without submitting', async () => {
    makeVoice();
    const gateway = fakeGateway({ gate: vi.fn(async () => ({ ok: false as const, error: 'Pick a model first.' })) });
    expect(await calibrateWritingVoice('v', { gateway, contentRoot: root })).toMatchObject({
      lastError: 'Pick a model first.',
    });
    expect(gateway.submitted).toEqual([]);
  });

  it('treats a quiet idle session as finished', async () => {
    makeVoice();
    const gateway = fakeGateway({ liveStatus: vi.fn(async () => 'idle') });
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    writeStyle();
    await vi.advanceTimersByTimeAsync(3 * MIN + 1);
    expect(await done).toMatchObject({ status: 'ready' });
  });

  it('stops a turn that runs past 20 minutes', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    await vi.advanceTimersByTimeAsync(20 * MIN + 1);
    expect(await done).toMatchObject({
      status: 'not-calibrated',
      lastError: 'Calibration took too long and was stopped.',
    });
    expect(gateway.cancelled).toEqual(['rt-1']);
  });

  it('runs one calibration at a time', async () => {
    makeVoice('a');
    makeVoice('b');
    const gateway = fakeGateway();
    const steps: WritingVoiceProgress[] = [];
    const first = calibrateWritingVoice('a', { gateway, contentRoot: root, onProgress: (p) => steps.push(p) });
    const second = calibrateWritingVoice('b', { gateway, contentRoot: root, onProgress: (p) => steps.push(p) });
    await gateway.untilSubmitted(1);
    expect(steps.find((p) => p.id === 'b')?.step).toBe('waiting');
    expect(gateway.created).toBe(1);
    gateway.emit('message.complete', 'rt-1');
    await first;
    await gateway.untilSubmitted(2);
    expect(gateway.created).toBe(2);
    gateway.emit('message.complete', 'rt-2');
    await second;
  });

  it('says a calibration from an earlier run was interrupted', async () => {
    upsertWritingVoiceRecord(record({ status: 'calibrating' }));
    resetInterruptedCalibrations();
    expect(stored()).toMatchObject({
      status: 'not-calibrated',
      lastError: 'Calibration was interrupted. Try again.',
    });
  });

  it('leaves a calibration running in this process alone', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    resetInterruptedCalibrations();
    expect(stored().status).toBe('calibrating');
    gateway.emit('message.complete', 'rt-1');
    await done;
  });

  it('does not count an old STYLE.md as a new calibration', async () => {
    makeVoice();
    writeStyle();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    gateway.emit('message.complete', 'rt-1', { status: 'complete' });
    expect(await done).toMatchObject({
      status: 'not-calibrated',
      lastError: 'Calibration ended without a usable style guide.',
    });
  });

  it('fails a turn that ends in an error even if STYLE.md was written', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    writeStyle();
    gateway.emit('message.complete', 'rt-1', { status: 'error' });
    expect(await done).toMatchObject({ status: 'not-calibrated', lastError: "Calibration didn't finish." });
  });

  it('keeps the sample set calibration read, so later changes still show', async () => {
    makeVoice();
    const gateway = fakeGateway();
    const done = calibrateWritingVoice('v', { gateway, contentRoot: root });
    await gateway.untilSubmitted(1);
    const samples = path.join(writingVoiceDir('v', root), 'samples');
    const { hashWritingVoiceSamples, writingVoiceFiles } = await import('../writingVoicePaths');
    const before = await hashWritingVoiceSamples(writingVoiceFiles(root), 'voice/v/samples');
    fs.writeFileSync(path.join(samples, 'added-during.md'), 'more words');
    writeStyle();
    gateway.emit('message.complete', 'rt-1', { status: 'complete' });
    expect(await done).toMatchObject({ status: 'ready', sampleHash: before });
  });
});

