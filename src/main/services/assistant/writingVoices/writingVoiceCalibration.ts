import type {
  WritingVoiceProgress,
  WritingVoiceRecord,
  WritingVoiceStep,
} from '../../../../shared/types/writingVoices';
import { persistDebugLog } from '../../../persistDebugLog';
import { checkWritingVoiceStyle } from './writingVoiceStyle';
import { listWritingVoiceRecords, upsertWritingVoiceRecord } from './writingVoiceStore';
import { hashWritingVoiceSamples, writingVoiceFiles, writingVoiceRel } from './writingVoicePaths';
import { createSerialQueue } from '../../../../shared/utils/serialQueue';
import { TURN_QUIET_MS } from '../hermes/turnQuiet';

/** A calibration still running after this is stopped. */
const CAP_MS = 20 * 60 * 1000;
const SESSION_TITLE = 'Writing voice calibration';

const ERRORS = {
  notReady: 'Start the assistant first.',
  noStyle: 'Calibration ended without a usable style guide.',
  tooLong: 'Calibration took too long and was stopped.',
  failed: "Calibration didn't finish.",
  interrupted: 'Calibration was interrupted. Try again.',
};

type GatewayEvent = { session_id?: string; payload?: unknown };

/** What calibration needs from the stack; the default wraps the app's gateway session. */
export interface CalibrationGateway {
  ready(): Promise<boolean>;
  gate(sessionId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** A hidden session on the built-in agent: the runtime id for events, the stored id for lists. */
  createSession(): Promise<{ id: string; storedId: string }>;
  submit(sessionId: string, text: string): Promise<void>;
  on(event: string, handler: (event: GatewayEvent) => void): () => void;
  liveStatus(sessionId: string): Promise<string | null>;
  cancel(sessionId: string): Promise<void>;
}

async function defaultGateway(): Promise<CalibrationGateway> {
  const [{ getHermesGatewaySession }, { isAssistantStackReady }, { ensureResolvedInferenceReady }] =
    await Promise.all([
      import('../hermes/hermesGatewaySession'),
      import('../AssistantStackService'),
      import('../hermes/sessionInference'),
    ]);
  const gateway = getHermesGatewaySession();
  return {
    ready: () => isAssistantStackReady(),
    gate: async (sessionId) => {
      const result = await ensureResolvedInferenceReady(sessionId);
      return 'error' in result ? { ok: false, error: result.error } : { ok: true };
    },
    createSession: async () => {
      const id = await gateway.createSessionWithSeed({ profile: null, hidden: true, title: SESSION_TITLE });
      return { id, storedId: gateway.storedSessionId(id) };
    },
    submit: async (sessionId, text) => {
      await gateway.submitPrompt(sessionId, text);
    },
    on: (event, handler) => gateway.on(event, handler as never),
    liveStatus: (sessionId) => gateway.getLiveStatus(sessionId, null),
    cancel: (sessionId) => gateway.cancelPrompt(sessionId),
  };
}

export function writingVoiceCalibrationPrompt(id: string): string {
  const dir = `/opt/voice/${id}`;
  return (
    `Calibrate the writing voice in ${dir}/ with the write-in-voice skill. ` +
    `Its samples are in ${dir}/samples/. ` +
    `Write ${dir}/STYLE.md from the skill's template, with exemplars as paths relative to ${dir}/. ` +
    "Don't ask questions. If something stops you, say what in one line."
  );
}

/** Ids queued or running in this process. */
const active = new Set<string>();
const chain = createSerialQueue();

function update(id: string, patch: Partial<WritingVoiceRecord>): WritingVoiceRecord {
  const current = listWritingVoiceRecords().find((v) => v.id === id);
  if (!current) throw new Error('No such voice');
  const next = { ...current, ...patch };
  upsertWritingVoiceRecord(next);
  return next;
}

/** A record left `calibrating` by an earlier run of the app has nothing behind it now. */
export function resetInterruptedCalibrations(): void {
  for (const voice of listWritingVoiceRecords()) {
    if (voice.status === 'calibrating' && !active.has(voice.id)) {
      upsertWritingVoiceRecord({ ...voice, status: 'not-calibrated', lastError: ERRORS.interrupted });
    }
  }
}

export function isWritingVoiceCalibrating(id: string): boolean {
  return active.has(id);
}

/** Where a calibration in this process has got to, for the voice list. */
const steps = new Map<string, WritingVoiceStep>();

export function writingVoiceStep(id: string): WritingVoiceStep | null {
  return steps.get(id) ?? null;
}

type TurnEnd = 'complete' | 'error' | 'idle' | 'cap';

/** Resolves when the session's turn ends: message.complete, a quiet idle session, or the cap. */
function waitForTurnEnd(
  gateway: CalibrationGateway,
  sessionId: string,
  onTool: (name: string) => void
): { ended: Promise<TurnEnd>; stop: () => void; tools: () => number } {
  let tools = 0;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let cap: ReturnType<typeof setTimeout> | null = null;
  const unsubs: Array<() => void> = [];
  let finish: (end: TurnEnd) => void = () => undefined;
  const ended = new Promise<TurnEnd>((resolve) => {
    finish = (end) => {
      stop();
      resolve(end);
    };
  });
  const stop = () => {
    if (quiet) clearTimeout(quiet);
    if (cap) clearTimeout(cap);
    quiet = cap = null;
    for (const unsub of unsubs.splice(0)) unsub();
  };
  const arm = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => {
      void gateway
        .liveStatus(sessionId)
        .catch((): null => null)
        .then((status) => {
          if (status === null || status === 'idle') finish('idle');
          else arm();
        });
    }, TURN_QUIET_MS);
  };
  const mine = (event: GatewayEvent) => event.session_id === sessionId;
  unsubs.push(
    gateway.on('tool.start', (event) => {
      if (!mine(event)) return;
      tools += 1;
      arm();
      const name = (event.payload as { name?: unknown } | undefined)?.name;
      onTool(typeof name === 'string' ? name : '');
    }),
    gateway.on('message.complete', (event) => {
      if (!mine(event)) return;
      const status = (event.payload as { status?: unknown } | undefined)?.status;
      finish(status === undefined || status === 'complete' ? 'complete' : 'error');
    })
  );
  arm();
  cap = setTimeout(() => finish('cap'), CAP_MS);
  return { ended, stop, tools: () => tools };
}

async function run(
  id: string,
  deps: CalibrationDeps,
  progress: (step: WritingVoiceStep | null, record: WritingVoiceRecord) => void
): Promise<WritingVoiceRecord> {
  const started = Date.now();
  let record = update(id, { status: 'calibrating', lastError: null });
  progress('starting', record);
  const fail = (error: string, outcome: string, tools = 0) => {
    record = update(id, { status: 'not-calibrated', lastError: error });
    persistDebugLog('writing-voices', 'calibration', { id, outcome, ms: Date.now() - started, tools });
    return record;
  };
  let turn: ReturnType<typeof waitForTurnEnd> | null = null;
  try {
    const gateway = deps.gateway ?? (await defaultGateway());
    if (!(await gateway.ready())) return fail(ERRORS.notReady, 'not-ready');
    const session = await gateway.createSession();
    const ids = [...(record.calibrationSessionIds ?? []), session.storedId];
    record = update(id, { calibrationSessionIds: ids });
    const gate = await gateway.gate(session.id);
    if ('error' in gate) return fail(gate.error, 'gate');

    let step: WritingVoiceStep = 'starting';
    const advance = (next: WritingVoiceStep) => {
      const order: WritingVoiceStep[] = ['starting', 'reading', 'writing', 'checking'];
      if (order.indexOf(next) <= order.indexOf(step)) return;
      step = next;
      progress(step, record);
    };
    // What calibration reads, taken before the turn: a STYLE.md left from an earlier run must
    // not pass for a new one, and samples added meanwhile must still show as changed.
    const files = writingVoiceFiles(deps.contentRoot);
    const rel = writingVoiceRel(id);
    const styleFile = `${rel}/STYLE.md`;
    const styleBefore = await files.readText('userContent', styleFile).catch((): null => null);
    const sampleHash = await hashWritingVoiceSamples(files, `${rel}/samples`);
    turn = waitForTurnEnd(gateway, session.id, (name) =>
      advance(name === 'write_file' || name === 'patch' ? 'writing' : 'reading')
    );
    await gateway.submit(session.id, writingVoiceCalibrationPrompt(id));
    const end = await turn.ended;
    if (end === 'cap') {
      await gateway.cancel(session.id).catch((): undefined => undefined);
      return fail(ERRORS.tooLong, 'cap', turn.tools());
    }
    if (end === 'error') return fail(ERRORS.failed, 'turn-error', turn.tools());
    advance('checking');
    const check = await checkWritingVoiceStyle(files, rel);
    if ('reason' in check) return fail(ERRORS.noStyle, check.reason, turn.tools());
    const styleAfter = await files.readText('userContent', styleFile).catch((): null => null);
    if (styleAfter === styleBefore) return fail(ERRORS.noStyle, 'unchanged', turn.tools());
    record = update(id, {
      status: 'ready',
      lastError: null,
      calibratedAt: (deps.now ?? (() => new Date()))().toISOString(),
      sampleHash,
    });
    persistDebugLog('writing-voices', 'calibration', {
      id,
      outcome: 'ready',
      ms: Date.now() - started,
      tools: turn.tools(),
    });
    return record;
  } catch (error) {
    persistDebugLog('writing-voices', 'calibration failed', {
      id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return fail(ERRORS.failed, 'error');
  } finally {
    turn?.stop();
  }
}

export interface CalibrationDeps {
  gateway?: CalibrationGateway;
  contentRoot?: string;
  now?: () => Date;
  onProgress?: (progress: WritingVoiceProgress) => void;
}

/**
 * Calibrate a voice on the built-in agent (ADR 0056 §4): one turn on a hidden session, then
 * Ready only when STYLE.md checks out. Calibrations run one at a time.
 */
export function calibrateWritingVoice(id: string, deps: CalibrationDeps = {}): Promise<WritingVoiceRecord> {
  const report = (step: WritingVoiceStep | null, record: WritingVoiceRecord) => {
    if (step) steps.set(id, step);
    else steps.delete(id);
    deps.onProgress?.({
      id,
      status: record.status,
      step,
      lastError: record.lastError ?? null,
    });
  };
  const busy = active.size > 0;
  active.add(id);
  const queued = update(id, { status: 'calibrating', lastError: null });
  if (busy) report('waiting', queued);
  const result = chain(() => run(id, deps, report));
  return result.then(
    (record) => {
      active.delete(id);
      report(null, record);
      return record;
    },
    (error) => {
      active.delete(id);
      throw error;
    }
  );
}
