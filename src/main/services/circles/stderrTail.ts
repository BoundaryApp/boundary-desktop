/** Keeps the end of a child process's stderr, for the debug log when the child dies. */

const TAIL_CHARS = 8192;
const SETTLE_MS = 500;

interface Echo {
  write: (text: string) => unknown;
}

export interface StderrCapture {
  /** The output so far once the stream has ended, or after `waitMs` if it hasn't. */
  settled: (waitMs?: number) => Promise<{ bytes: number; tail: string }>;
}

/** Passes each chunk on to `echo`, so a Boundary started from Terminal still shows it. */
export function captureStderr(
  stream: NodeJS.ReadableStream | null,
  echo: Echo = process.stderr,
  limit = TAIL_CHARS
): StderrCapture {
  let tail = '';
  let bytes = 0;
  let ended = !stream;
  const waiting: Array<() => void> = [];
  stream?.on('data', (chunk: Buffer | string) => {
    const text = chunk.toString();
    bytes += Buffer.byteLength(text);
    tail = (tail + text).slice(-limit);
    echo.write(text);
  });
  stream?.once('end', () => {
    ended = true;
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    settled: (waitMs = SETTLE_MS) =>
      new Promise((resolve) => {
        const done = () => resolve({ bytes, tail });
        if (ended) return done();
        const timer = setTimeout(done, waitMs);
        waiting.push(() => {
          clearTimeout(timer);
          done();
        });
      }),
  };
}
