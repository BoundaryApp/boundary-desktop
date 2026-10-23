import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * Google Chrome on Boundary's own profile, driven over `--remote-debugging-pipe` (ADR 0027 §4).
 *
 * A pipe instead of `--remote-debugging-port`: a debugging port has no authentication, and every
 * container can reach host loopback (Chrome only checks that Host is an IP, which a container
 * can send). With the pipe, the bridge is the only way in, so its filter can't be bypassed.
 *
 * Messages are JSON, NUL-terminated; fd 3 carries commands to Chrome, fd 4 replies and events.
 */

// CDP messages are untyped JSON from Chrome or a client; fields are checked where they are used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface ChromeLaunchConfig {
  chromePath: string;
  profileDir: string;
}

export function chromeArgs(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    // Starting Chrome for automation sets navigator.webdriver, which sites check.
    // This clears it.
    '--disable-blink-features=AutomationControlled',
    // Without it Chrome shows "You are using an unsupported command-line flag" for the line above.
    // ChromeDriver passes it too. Checked on Chrome 155: navigator.webdriver stays false.
    '--test-type',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];
}

/** Splits a NUL-framed stream into messages; returns the unfinished tail. */
export function splitFrames(buffer: string, onFrame: (frame: string) => void): string {
  let rest = buffer;
  let end: number;
  while ((end = rest.indexOf('\0')) >= 0) {
    const frame = rest.slice(0, end);
    rest = rest.slice(end + 1);
    if (frame) onFrame(frame);
  }
  return rest;
}

export class ChromePipe {
  private exited = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly toChrome: Writable
  ) {}

  static launch(
    config: ChromeLaunchConfig,
    onMessage: (message: Json) => void,
    onExit: (code: number | null) => void
  ): ChromePipe {
    const proc = spawn(config.chromePath, chromeArgs(config.profileDir), {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const toChrome = proc.stdio[3] as Writable;
    const fromChrome = proc.stdio[4] as Readable;
    const pipe = new ChromePipe(proc, toChrome);

    let buffer = '';
    fromChrome.setEncoding('utf8');
    fromChrome.on('data', (chunk: string) => {
      buffer = splitFrames(buffer + chunk, (frame) => {
        try {
          onMessage(JSON.parse(frame));
        } catch {
          /* not JSON: ignore */
        }
      });
    });
    // Writes after Chrome quits fail with EPIPE; the exit handler deals with the fallout.
    toChrome.on('error', () => {
      /* EPIPE after exit: the exit handler reports it */
    });
    proc.once('exit', (code) => {
      pipe.exited = true;
      onExit(code);
    });
    proc.once('error', () => {
      pipe.exited = true;
      onExit(null);
    });
    return pipe;
  }

  get running(): boolean {
    return !this.exited;
  }

  send(message: Json): void {
    if (this.exited) return;
    this.toChrome.write(`${JSON.stringify(message)}\0`);
  }

  /** Ask Chrome to quit, then make sure it has. */
  async close(timeoutMs = 3_000): Promise<void> {
    if (this.exited) return;
    // An id outside both the forwarded and the multiplexer's own ranges.
    this.send({ id: 2_100_000_000, method: 'Browser.close' });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.proc.kill('SIGKILL');
        resolve();
      }, timeoutMs);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
