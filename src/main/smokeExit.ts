/**
 * Startup smoke check for packaged builds (`BOUNDARY_SMOKE_EXIT=1`). CI launches each package
 * this way: the app exits 0 once the main window's renderer has loaded and mounted something
 * into `#root`, and 1 if loading fails, the renderer dies, or neither happens before the timeout.
 * Smoke runs skip the agent stack, the host bridge and Circles, so they need no container engine.
 */

const SMOKE_TIMEOUT_MS = 60_000;

/** Delay after `did-finish-load` before reading `#root`, so React has committed its first render. */
const SMOKE_MOUNT_DELAY_MS = 2_000;

export function isSmokeRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOUNDARY_SMOKE_EXIT === '1';
}

type SmokeWebContents = {
  on(event: 'did-finish-load', listener: () => void): unknown;
  on(event: 'did-fail-load', listener: (event: unknown, errorCode: number, errorDescription: string) => void): unknown;
  on(event: 'render-process-gone', listener: (event: unknown, details: { reason: string }) => void): unknown;
  executeJavaScript(code: string): Promise<unknown>;
};

export type SmokeDeps = {
  exit: (code: number) => void;
  log: (message: string, fields: Record<string, unknown>) => void;
  timeoutMs?: number;
  mountDelayMs?: number;
};

export function attachSmokeExit(webContents: SmokeWebContents, deps: SmokeDeps): void {
  let done = false;
  const finish = (code: number, message: string, fields: Record<string, unknown> = {}) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    deps.log(message, { code, ...fields });
    deps.exit(code);
  };
  const timeoutMs = deps.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const timer = setTimeout(() => finish(1, 'smoke: timed out', { timeoutMs }), timeoutMs);

  webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    finish(1, 'smoke: renderer failed to load', { errorCode, errorDescription });
  });
  webContents.on('render-process-gone', (_event, details) => {
    finish(1, 'smoke: renderer gone', { reason: details.reason });
  });
  webContents.on('did-finish-load', () => {
    setTimeout(() => {
      webContents
        .executeJavaScript('document.getElementById("root")?.childElementCount ?? 0')
        .then((count) => {
          if (typeof count === 'number' && count > 0) finish(0, 'smoke: renderer mounted', { count });
          else finish(1, 'smoke: renderer loaded but #root is empty', { count });
        })
        .catch((error: unknown) => {
          finish(1, 'smoke: could not read #root', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, deps.mountDelayMs ?? SMOKE_MOUNT_DELAY_MS);
  });
}

/** Startup failed before the window opened. A smoke run must not report that as success. */
export function failSmokeRun(deps: Pick<SmokeDeps, 'exit' | 'log'>, error: unknown): void {
  deps.log('smoke: startup failed', { error: error instanceof Error ? error.message : String(error) });
  deps.exit(1);
}
