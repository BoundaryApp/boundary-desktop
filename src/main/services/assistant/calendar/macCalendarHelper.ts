import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';
import { persistDebugLog } from '../../../persistDebugLog';
import {
  MacHelperError,
  type MacCalendarOp,
  type MacHelperErrorCode,
  type MacHelperState,
} from './macCalendarProtocol';

const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Listing and searching events walk every allowed calendar over the asked range, which can take a
 * while on a large calendar. Kept below the 60 s Hermes waits for a calendar-mac call, so a hung
 * read still reaches the agent as a timeout rather than Hermes giving up first.
 */
const READ_TIMEOUT_MS = 45_000;
const SLOW_READ_OPS: ReadonlySet<MacCalendarOp> = new Set(['listEvents', 'search']);
/**
 * One automatic restart after a crash; after that the helper stays stopped until restart(). A
 * request that times out counts as a crash: the helper answers one request at a time, so a hung
 * helper would time out every later request too.
 */
const MAX_AUTO_RESTARTS = 1;
/** A helper that ran this long before it crashed or hung was healthy, so its crash count resets. */
const HEALTHY_RUN_MS = 60_000;
/** Waits for the person to answer a system prompt, so it has no timeout. */
const OPS_WITHOUT_TIMEOUT: ReadonlySet<MacCalendarOp> = new Set(['requestAccess']);

interface Pending {
  op: MacCalendarOp;
  resolve: (value: never) => void;
  reject: (error: MacHelperError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface MacCalendarHelperOptions {
  binaryPath: string;
  args?: string[];
  spawn?: typeof nodeSpawn;
  /** Receives op names, ids, codes, counts and lengths. Never request params or reply results. */
  log: (msg: string, data?: Record<string, unknown>) => void;
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  'denied',
  'not_found',
  'invalid',
  'read_only',
  'internal',
]);

/** Runs the Swift calendar helper and speaks its JSON-lines protocol over stdin and stdout. */
export class MacCalendarHelper {
  private readonly opts: MacCalendarHelperOptions;
  private child: ChildProcess | null = null;
  private currentState: MacHelperState = 'idle';
  private nextId = 1;
  private autoRestarts = 0;
  private startedAt = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly changedListeners = new Set<() => void>();

  constructor(opts: MacCalendarHelperOptions) {
    this.opts = opts;
  }

  state(): MacHelperState {
    return this.currentState;
  }

  request<T>(op: MacCalendarOp, params: object = {}): Promise<T> {
    if (this.currentState === 'stopped') {
      return Promise.reject(new MacHelperError('stopped', 'The calendar helper stopped'));
    }
    if (this.currentState === 'missing') {
      return Promise.reject(new MacHelperError('missing', 'The calendar helper is not installed'));
    }
    if (!this.child) this.start();
    // start() can fail synchronously and change the state.
    const child = this.child;
    if (!child || !child.stdin) {
      return Promise.reject(this.stateError());
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        op,
        resolve: resolve as (value: never) => void,
        reject,
        timer: null,
      };
      this.pending.set(id, entry);
      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      this.armOldest(child);
    });
  }

  /**
   * Starts the timeout of the oldest request still waiting. The helper answers one request at a
   * time, in order (requestAccess aside), so a request queued behind a slow one is timed from when
   * the helper reaches it: the moment the reply before it arrives.
   */
  private armOldest(child: ChildProcess): void {
    for (const [id, entry] of this.pending) {
      if (OPS_WITHOUT_TIMEOUT.has(entry.op)) continue;
      if (entry.timer) return;
      const { op } = entry;
      entry.timer = setTimeout(
        () => {
          this.pending.delete(id);
          this.opts.log('calendar helper request timed out', { op, id });
          entry.reject(new MacHelperError('timeout', `The calendar helper did not answer ${op} in time`));
          this.handleHang(child);
        },
        SLOW_READ_OPS.has(op) ? READ_TIMEOUT_MS : REQUEST_TIMEOUT_MS
      );
      return;
    }
  }

  onChanged(cb: () => void): () => void {
    this.changedListeners.add(cb);
    return () => {
      this.changedListeners.delete(cb);
    };
  }

  /** Clears the crash count and starts a fresh helper. */
  restart(): void {
    this.killChild();
    this.rejectAll(new MacHelperError('stopped', 'The calendar helper restarted'));
    this.autoRestarts = 0;
    this.currentState = 'idle';
    this.start();
  }

  stop(): void {
    this.currentState = 'stopped';
    this.killChild();
    this.rejectAll(new MacHelperError('stopped', 'The calendar helper stopped'));
  }

  private stateError(): MacHelperError {
    return this.currentState === 'missing'
      ? new MacHelperError('missing', 'The calendar helper is not installed')
      : new MacHelperError('stopped', 'The calendar helper stopped');
  }

  private start(): void {
    const spawnFn = this.opts.spawn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(this.opts.binaryPath, this.opts.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.markMissing((error as NodeJS.ErrnoException).code);
      return;
    }
    this.child = child;
    this.currentState = 'running';
    this.startedAt = Date.now();
    this.opts.log('calendar helper started', { pid: child.pid ?? null });

    child.stdin?.on('error', () => {
      // The exit handler rejects what was waiting.
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.opts.log('calendar helper stderr', { length: chunk.length });
    });
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.child === child) this.handleLine(line);
      });
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = null;
      this.markMissing(error.code);
    });
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.opts.log('calendar helper exited', { code, signal });
      this.rejectAll(new MacHelperError('internal', 'The calendar helper exited'));
      this.afterCrash();
    });
  }

  /** A request to `child` timed out: stop it and handle it as a crash. */
  private handleHang(child: ChildProcess): void {
    if (this.child !== child) return;
    this.opts.log('calendar helper stopped answering', { pid: child.pid ?? null });
    this.killChild();
    this.rejectAll(new MacHelperError('internal', 'The calendar helper stopped answering'));
    this.afterCrash();
  }

  /** Restarts once after a crash, then stays stopped. A long healthy run clears the count. */
  private afterCrash(): void {
    if (this.currentState === 'missing' || this.currentState === 'stopped') return;
    if (Date.now() - this.startedAt >= HEALTHY_RUN_MS) this.autoRestarts = 0;
    if (this.autoRestarts < MAX_AUTO_RESTARTS) {
      this.autoRestarts += 1;
      this.start();
    } else {
      this.currentState = 'stopped';
      this.opts.log('calendar helper stopped after repeated failures', { restarts: this.autoRestarts });
    }
  }

  private markMissing(code: string | undefined): void {
    this.currentState = 'missing';
    this.opts.log('calendar helper could not start', { code: code ?? null });
    this.rejectAll(new MacHelperError('missing', 'The calendar helper is not installed'));
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  private rejectAll(error: MacHelperError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log('calendar helper sent an unreadable line', { length: line.length });
      return;
    }
    if (!msg || typeof msg !== 'object') {
      this.opts.log('calendar helper sent an unreadable line', { length: line.length });
      return;
    }
    const record = msg as Record<string, unknown>;
    if (record.event === 'changed') {
      for (const cb of [...this.changedListeners]) {
        try {
          cb();
        } catch (error) {
          this.opts.log('calendar changed listener threw', {
            name: error instanceof Error ? error.name : 'unknown',
          });
        }
      }
      return;
    }
    if (typeof record.id !== 'number') {
      // A reply with "id": null answers a line the helper could not read; nothing is waiting.
      this.opts.log('calendar helper reply had no id', { length: line.length });
      return;
    }
    const entry = this.pending.get(record.id);
    if (!entry) return;
    this.pending.delete(record.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (this.child) this.armOldest(this.child);
    if (record.ok === true) {
      entry.resolve(record.result as never);
      return;
    }
    const err = (record.error ?? {}) as { code?: unknown; message?: unknown };
    const code: MacHelperErrorCode =
      typeof err.code === 'string' && ERROR_CODES.has(err.code)
        ? (err.code as MacHelperErrorCode)
        : 'internal';
    this.opts.log('calendar helper returned an error', { id: record.id, code });
    entry.reject(
      new MacHelperError(code, typeof err.message === 'string' ? err.message : 'Calendar helper error')
    );
  }
}

const HELPER_NAME = 'boundary-calendar-helper';

function resolveMacCalendarHelperPath(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'calendar-helper')
    : path.join(app.getAppPath(), 'resources', 'calendar-helper');
  return path.join(base, HELPER_NAME);
}

let singleton: MacCalendarHelper | null = null;

/** The app's one helper. It starts on its first request. */
export function getMacCalendarHelper(): MacCalendarHelper {
  if (!singleton) {
    // Dev runs can point the helper at synthetic data instead of the real calendars.
    const fixture = process.env.BOUNDARY_CALENDAR_HELPER_FIXTURE;
    singleton = new MacCalendarHelper({
      binaryPath: resolveMacCalendarHelperPath(),
      args: fixture ? ['--fixture', fixture] : [],
      log: (msg, data) => persistDebugLog('calendars', msg, data ?? {}),
    });
  }
  return singleton;
}

/** Stops the helper if one was created. */
export function stopMacCalendarHelper(): void {
  singleton?.stop();
}
