/**
 * Reads the `usage` object a pool reply carries, for the spend log (ADR 0047 phase 5), without
 * changing what reaches Hermes: each chunk is passed on as it arrives, then a decoded copy is
 * scanned. A streamed reply's usage is in its last `data:` event that has one; a JSON reply's is
 * at the top level.
 */

/** A JSON reply longer than this isn't scanned; its bytes still pass through. */
const JSON_SCAN_LIMIT = 2 * 1024 * 1024;
/** An SSE line longer than this is skipped rather than held. */
const LINE_LIMIT = 2 * 1024 * 1024;
const USAGE_OBJECT = /"usage"\s*:\s*\{/;

function usageOf(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const usage = (parsed as { usage?: unknown }).usage;
    return typeof usage === 'object' && usage !== null ? usage : null;
  } catch {
    return null;
  }
}

/** Collects the last usage object from an event stream, one decoded piece at a time. */
class SseScanner {
  usage: unknown = null;
  private pending = '';
  /** Set while dropping the rest of an over-long line. */
  private skipping = false;

  push(text: string): void {
    const lines = (this.pending + text).split('\n');
    this.pending = lines.pop() ?? '';
    for (const line of lines) {
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      this.line(line);
    }
    if (this.pending.length > LINE_LIMIT) {
      this.pending = '';
      this.skipping = true;
    }
  }

  end(): void {
    if (!this.skipping) this.line(this.pending);
    this.pending = '';
  }

  private line(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:') || !USAGE_OBJECT.test(line)) return;
    const usage = usageOf(line.slice(5).trim());
    if (usage !== null) this.usage = usage;
  }
}

/** Collects a JSON reply's text up to the scan limit, then its usage at the end. */
class JsonScanner {
  usage: unknown = null;
  private text = '';
  private overflowed = false;

  push(text: string): void {
    if (this.overflowed) return;
    if (this.text.length + text.length > JSON_SCAN_LIMIT) {
      this.overflowed = true;
      this.text = '';
      return;
    }
    this.text += text;
  }

  end(): void {
    if (!this.overflowed) this.usage = usageOf(this.text);
    this.text = '';
  }
}

/**
 * The response with the same status, status text, headers and body bytes. `onDone` runs once,
 * when the body ends, errors or is cancelled, with the last usage object seen or null. A
 * response without a body reports null at once and is returned as is.
 */
export function meterUsage(response: Response, onDone: (usage: unknown) => void): Response {
  const source = response.body;
  let reported = false;
  const report = (usage: unknown): void => {
    if (reported) return;
    reported = true;
    try {
      onDone(usage);
    } catch {
      // Recording is best effort; it must never break the reply.
    }
  };
  if (!source) {
    report(null);
    return response;
  }

  const isJson = /json/i.test(response.headers.get('content-type') ?? '');
  const scanner = isJson ? new JsonScanner() : new SseScanner();
  const decoder = new TextDecoder();
  const reader = source.getReader();

  const metered = new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          report(scanner.usage);
          controller.error(error);
          return;
        }
        if (read.done) {
          scanner.push(decoder.decode());
          scanner.end();
          controller.close();
          report(scanner.usage);
          return;
        }
        controller.enqueue(read.value);
        scanner.push(decoder.decode(read.value, { stream: true }));
      },
      cancel(reason): Promise<void> {
        report(scanner.usage);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );

  return new Response(metered, { status: response.status, statusText: response.statusText, headers: response.headers });
}
