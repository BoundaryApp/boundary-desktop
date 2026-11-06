/**
 * A CPU profile kept in rolling windows over a DevTools protocol connection, written only when
 * the lag probe saves a stall (see lagProbe.ts). Used for the main process through
 * node:inspector and for a renderer through webContents.debugger.
 */

/** Sends one DevTools protocol command and resolves its result. */
export type ProtocolSend = (method: string, params?: object) => Promise<unknown>;

export interface RollingProfilerOptions {
  /** How long each window runs before the previous one is replaced. */
  windowMs: number;
  /** Microseconds between samples. */
  samplingIntervalUs: number;
  /** A window younger than this saves the one before it too, so a stall at its start has context. */
  youngWindowMs: number;
  now: () => number;
  writeFile: (file: string, contents: string) => Promise<void>;
  /** Called after each protocol round trip, so the stall detector can discount the probe's own work. */
  onWork?: () => void;
}

export interface RollingProfiler {
  /** Enables the profiler and starts the first window. Rejects when the connection refuses. */
  start(): Promise<void>;
  /** Ends the current window, saves it (and the one before, if this one is young), starts the next. */
  save(base: string): Promise<string[]>;
  /** Ends the current window and keeps it as the previous one. Called every `windowMs`. */
  rotate(): Promise<void>;
  /** Stops rotating. The connection is the caller's to close. */
  stop(): void;
}

export function createRollingProfiler(send: ProtocolSend, options: RollingProfilerOptions): RollingProfiler {
  let running = false;
  let windowStartedAt = 0;
  let previous: unknown = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  // save and rotate both stop and restart the profiler; one at a time keeps them from overlapping.
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch((): void => undefined);
    return next;
  };

  async function begin(): Promise<void> {
    await send('Profiler.start');
    windowStartedAt = options.now();
    options.onWork?.();
  }

  async function end(): Promise<unknown> {
    const { profile } = (await send('Profiler.stop')) as { profile: unknown };
    options.onWork?.();
    return profile;
  }

  const rotate = () =>
    serial(async () => {
      if (!running) return;
      previous = await end();
      await begin();
    });

  return {
    async start() {
      await send('Profiler.enable');
      await send('Profiler.setSamplingInterval', { interval: options.samplingIntervalUs });
      await begin();
      running = true;
      timer = setInterval(() => void rotate().catch((): void => undefined), options.windowMs);
      (timer as { unref?: () => void }).unref?.();
    },
    save: (base) =>
      serial(async () => {
        if (!running) return [];
        const youngWindow = options.now() - windowStartedAt < options.youngWindowMs;
        const current = await end();
        await begin();
        const files: [string, unknown][] = [[`${base}.cpuprofile`, current]];
        if (youngWindow && previous) files.push([`${base}-before.cpuprofile`, previous]);
        for (const [file, profile] of files) await options.writeFile(file, JSON.stringify(profile));
        options.onWork?.();
        return files.map(([file]) => file);
      }),
    rotate,
    stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
