/**
 * Rewrites a provider's server-sent event stream into the plain OpenAI stream Hermes reads.
 * Each event's data goes through `mapEvent`; the result is sent as `data: <mapped>\n\n`, and
 * `data: [DONE]` passes through as is. A `mapEvent` result of `[DONE]` ends the stream the same
 * way, for providers that end with an event of their own. Once `[DONE]` is sent the provider's
 * stream is cancelled and the output closes, so nothing after it reaches Hermes. A named event without data lines
 * reaches `mapEvent` with empty data; an unnamed one is skipped. When `mapEvent` returns `'fail'` or throws, the source
 * errors, an event grows past the size limit, or the source ends without `data: [DONE]`, the
 * stream ends with one error event, the provider's stream is cancelled and `onFail` runs once,
 * so nothing it couldn't read reaches Hermes and the caller can drop what it cached for the
 * provider. An abort isn't a failure: it cancels the source and errors the output.
 */

export type SseEvent = { event: string | null; data: string };

const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';
const DONE = '[DONE]';
/** An event whose lines grow past this without a blank line fails the stream rather than being held. */
const EVENT_LIMIT = 4 * 1024 * 1024;

export function transformSse(
  body: ReadableStream<Uint8Array>,
  mapEvent: (event: SseEvent) => string | null | 'fail',
  signal: AbortSignal,
  onFail?: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];
  let eventSize = 0;
  let finished = false;
  let sawDone = false;
  let onAbort: (() => void) | null = null;

  const stopInput = (reason?: unknown): void => {
    void reader.cancel(reason).catch((): undefined => undefined);
  };
  const cleanup = (): void => {
    finished = true;
    if (onAbort) signal.removeEventListener('abort', onAbort);
  };
  /** Sends `out` and the error event, then closes. */
  const failWith = (controller: ReadableStreamDefaultController<Uint8Array>, out = ''): void => {
    cleanup();
    stopInput();
    if (out) controller.enqueue(encoder.encode(out));
    controller.enqueue(encoder.encode(ERROR_EVENT));
    controller.close();
    try {
      onFail?.();
    } catch {
      // The caller's hook must not break the stream's ending.
    }
  };

  /** Sends `out`, which ends with `[DONE]`, cancels the provider's stream and closes. */
  const finishAtDone = (controller: ReadableStreamDefaultController<Uint8Array>, out: string): void => {
    cleanup();
    stopInput();
    if (out) controller.enqueue(encoder.encode(out));
    controller.close();
  };

  /** The text to send for one complete event, `'fail'` to end the stream, or null for nothing. */
  const dispatch = (): string | 'fail' | null => {
    const data = dataLines.join('\n');
    const event = eventName;
    const hadData = dataLines.length > 0;
    eventName = null;
    dataLines = [];
    eventSize = 0;
    if (!hadData && event === null) return null;
    if (hadData && data.trim() === DONE) {
      sawDone = true;
      return `data: ${DONE}\n\n`;
    }
    let mapped: string | null | 'fail';
    try {
      mapped = mapEvent({ event, data });
    } catch {
      return 'fail';
    }
    if (mapped === 'fail') return 'fail';
    if (mapped === null) return null;
    if (mapped === DONE) sawDone = true;
    return `data: ${mapped}\n\n`;
  };

  /** Parses whole lines out of `pending`. Returns the text to send and whether the stream failed. */
  const parse = (): { out: string; failed: boolean } => {
    let out = '';
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        const sent = dispatch();
        if (sent === 'fail') return { out, failed: true };
        if (sent !== null) out += sent;
        // Whatever follows [DONE] is never sent.
        if (sawDone) return { out, failed: false };
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        dataLines.push(value);
        eventSize += value.length;
      } else if (field === 'event') {
        eventName = value;
      }
    }
    if (eventSize + pending.length > EVENT_LIMIT) return { out, failed: true };
    return { out, failed: false };
  };

  return new ReadableStream<Uint8Array>(
    {
      start(controller): void {
        onAbort = (): void => {
          if (finished) return;
          cleanup();
          stopInput();
          controller.error(new Error('The request was cancelled.'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      },
      async pull(controller): Promise<void> {
        while (!finished) {
          let read: ReadableStreamReadResult<Uint8Array>;
          try {
            read = await reader.read();
          } catch {
            if (finished) return;
            failWith(controller);
            return;
          }
          if (finished) return;
          if (read.done) {
            pending += decoder.decode();
            // A final event without its blank line still counts once the stream has ended.
            pending += '\n\n';
            const { out, failed } = parse();
            // A stream that ends without [DONE] was cut off, or wasn't SSE at all.
            if (failed || !sawDone) {
              failWith(controller, out);
              return;
            }
            finishAtDone(controller, out);
            return;
          }
          pending += decoder.decode(read.value, { stream: true });
          const { out, failed } = parse();
          if (failed) {
            failWith(controller, out);
            return;
          }
          if (sawDone) {
            finishAtDone(controller, out);
            return;
          }
          if (out) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      },
      cancel(reason): Promise<void> {
        cleanup();
        return reader.cancel(reason).catch((): undefined => undefined);
      },
    },
    { highWaterMark: 0 }
  );
}
