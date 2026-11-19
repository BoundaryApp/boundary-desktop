/**
 * The network process's report of an error nothing caught. Without it the error reaches only
 * stderr, and main sees nothing but the exit code.
 */

/** Long enough for the parent port to carry the report before the process goes. */
const EXIT_DELAY_MS = 100;

interface FatalHost {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  exit(code: number): void;
}

interface FatalReport {
  /** To the debug log, through main. */
  log: (message: string, data: Record<string, unknown>) => void;
  /** To the diagnostics file, which takes metadata only. */
  diag: (event: string, data: Record<string, unknown>) => void;
  /** To stderr, as Node prints an uncaught error when nothing handles it. */
  print: (error: unknown) => void;
}

/** Exits with 1 after the first uncaught exception or unhandled rejection, as Node would. */
export function reportFatalErrors(host: FatalHost, report: FatalReport): void {
  let exiting = false;
  const onFatal = (kind: 'exception' | 'rejection') => (reason: unknown) => {
    if (exiting) return;
    exiting = true;
    const name = reason instanceof Error ? reason.name : typeof reason;
    try {
      report.print(reason);
      report.log('uncaught error', {
        kind,
        name,
        error: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? (reason.stack ?? null) : null,
      });
      report.diag('net.uncaught', { kind, name });
    } catch {
      // The port may already be closed; exit regardless.
    }
    setTimeout(() => host.exit(1), EXIT_DELAY_MS);
  };
  host.on('uncaughtException', onFatal('exception'));
  host.on('unhandledRejection', onFatal('rejection'));
}
