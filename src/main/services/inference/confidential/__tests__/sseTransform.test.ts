import { describe, expect, it, vi } from 'vitest';
import { transformSse, type SseEvent } from '../sseTransform';

const ERROR_EVENT = 'data: {"error":{"message":"The provider’s reply couldn’t be read."}}\n\n';

/** A source that serves `chunks` one read at a time and records whether it was cancelled. */
function source(chunks: string[], opts: { endless?: boolean } = {}): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<void> | void {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i]));
          i += 1;
          return;
        }
        if (opts.endless) return new Promise<void>(() => undefined);
        controller.close();
      },
      cancel(): void {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, cancelled: () => cancelled };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

const signal = (): AbortSignal => new AbortController().signal;
const upper = (e: SseEvent): string => e.data.toUpperCase();

describe('transformSse', () => {
  it('maps each event and passes [DONE] through', async () => {
    const { stream } = source(['data: a\n\n', 'data: b\n\ndata: [DONE]\n\n']);
    const onFail = vi.fn();
    expect(await readAll(transformSse(stream, upper, signal(), onFail))).toBe('data: A\n\ndata: B\n\ndata: [DONE]\n\n');
    expect(onFail).not.toHaveBeenCalled();
  });

  it('joins events split across reads, CRLF line ends and several data lines', async () => {
    const { stream } = source(['da', 'ta: o', 'ne\r\n\r', '\ndata: x\ndata: y\n', '\n', 'data: [DONE]\n\n']);
    const seen: SseEvent[] = [];
    const out = await readAll(
      transformSse(
        stream,
        (e) => {
          seen.push(e);
          return e.data.replace('\n', '+');
        },
        signal()
      )
    );
    expect(out).toBe('data: one\n\ndata: x+y\n\ndata: [DONE]\n\n');
    expect(seen.map((e) => e.data)).toEqual(['one', 'x\ny']);
  });

  it('passes the event name and skips comments and events mapped to null', async () => {
    const { stream } = source([': keep-alive\n\n', 'event: ping\ndata: {}\n\n', 'event: message\ndata: hi\n\n', 'data: [DONE]\n\n']);
    const out = await readAll(
      transformSse(stream, (e) => (e.event === 'ping' ? null : `${e.event}:${e.data}`), signal())
    );
    expect(out).toBe('data: message:hi\n\ndata: [DONE]\n\n');
  });

  it('ends the stream on an event mapped to [DONE]', async () => {
    const { stream } = source(['data: a\n\n', 'event: done\ndata: {}\n\n']);
    const onFail = vi.fn();
    const out = await readAll(transformSse(stream, (e) => (e.event === 'done' ? '[DONE]' : e.data), signal(), onFail));
    expect(out).toBe('data: a\n\ndata: [DONE]\n\n');
    expect(onFail).not.toHaveBeenCalled();
  });

  it('sends nothing after [DONE] and cancels the source', async () => {
    for (const [done, mapEvent] of [
      ['data: [DONE]\n\n', (e: SseEvent): string => e.data],
      ['event: done\ndata: {}\n\n', (e: SseEvent): string => (e.event === 'done' ? '[DONE]' : e.data)],
    ] as const) {
      const src = source(['data: a\n\n', `${done}data: after\n\n`, 'data: later\n\n'], { endless: true });
      const onFail = vi.fn();
      const seen: string[] = [];
      const out = await readAll(
        transformSse(
          src.stream,
          (e) => {
            seen.push(e.data);
            return mapEvent(e);
          },
          signal(),
          onFail
        )
      );
      expect(out).toBe('data: a\n\ndata: [DONE]\n\n');
      expect(seen).not.toContain('after');
      expect(src.cancelled()).toBe(true);
      expect(onFail).not.toHaveBeenCalled();
    }
  });

  it('maps a named event without data and skips an unnamed one', async () => {
    const { stream } = source(['event: done\n\n', 'id: 7\n\n']);
    const seen: SseEvent[] = [];
    const out = await readAll(
      transformSse(
        stream,
        (e) => {
          seen.push(e);
          return '[DONE]';
        },
        signal()
      )
    );
    expect(seen).toEqual([{ event: 'done', data: '' }]);
    expect(out).toBe('data: [DONE]\n\n');
  });

  it('ends with an error event and cancels the source on fail', async () => {
    const src = source(['data: a\n\n', 'data: bad\n\n', 'data: c\n\n'], { endless: true });
    const onFail = vi.fn();
    const out = await readAll(transformSse(src.stream, (e) => (e.data === 'bad' ? 'fail' : e.data), signal(), onFail));
    expect(out).toBe(`data: a\n\n${ERROR_EVENT}`);
    expect(src.cancelled()).toBe(true);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('treats a throw like fail', async () => {
    const src = source(['data: a\n\n'], { endless: true });
    const out = await readAll(
      transformSse(
        src.stream,
        () => {
          throw new Error('secret text');
        },
        signal()
      )
    );
    expect(out).toBe(ERROR_EVENT);
    expect(out).not.toContain('secret');
    expect(src.cancelled()).toBe(true);
  });

  it('ends with an error event when the source errors', async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): void {
          if (sent) return controller.error(new Error('socket said something'));
          sent = true;
          controller.enqueue(new TextEncoder().encode('data: a\n\n'));
        },
      },
      { highWaterMark: 0 }
    );
    const onFail = vi.fn();
    const out = await readAll(transformSse(stream, (e) => e.data, signal(), onFail));
    expect(out).toBe(`data: a\n\n${ERROR_EVENT}`);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('fails a stream that ends without [DONE]', async () => {
    const { stream } = source(['data: a\n\n']);
    const onFail = vi.fn();
    expect(await readAll(transformSse(stream, (e) => e.data, signal(), onFail))).toBe(`data: a\n\n${ERROR_EVENT}`);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('fails a body that isn’t SSE', async () => {
    const { stream } = source(['{"choices":[{"message":{"content":"x"}}]}']);
    const onFail = vi.fn();
    expect(await readAll(transformSse(stream, (e) => e.data, signal(), onFail))).toBe(ERROR_EVENT);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('fails an event that grows past the size limit', async () => {
    const big = 'x'.repeat(1024 * 1024);
    const src = source(['data: ', big, big, big, big, big], { endless: true });
    const onFail = vi.fn();
    expect(await readAll(transformSse(src.stream, (e) => e.data, signal(), onFail))).toBe(ERROR_EVENT);
    expect(src.cancelled()).toBe(true);
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('fails a truncated final event rather than passing it on', async () => {
    const { stream } = source(['data: {"a":1}\n\ndata: {"b"']);
    const out = await readAll(
      transformSse(
        stream,
        (e) => JSON.stringify(JSON.parse(e.data)),
        signal()
      )
    );
    expect(out).toBe(`data: {"a":1}\n\n${ERROR_EVENT}`);
  });

  it('cancels the source when the output is cancelled', async () => {
    const src = source(['data: a\n\n'], { endless: true });
    const out = transformSse(src.stream, (e) => e.data, signal());
    const reader = out.getReader();
    await reader.read();
    await reader.cancel();
    expect(src.cancelled()).toBe(true);
  });

  it('cancels the source and errors the output on abort', async () => {
    const src = source(['data: a\n\n'], { endless: true });
    const controller = new AbortController();
    const onFail = vi.fn();
    const reader = transformSse(src.stream, (e) => e.data, controller.signal, onFail).getReader();
    await reader.read();
    const next = reader.read();
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(src.cancelled()).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('never calls mapEvent for an already aborted signal', async () => {
    const src = source(['data: a\n\n']);
    const map = vi.fn((e: SseEvent) => e.data);
    const controller = new AbortController();
    controller.abort();
    await expect(readAll(transformSse(src.stream, map, controller.signal))).rejects.toThrow();
    expect(map).not.toHaveBeenCalled();
    expect(src.cancelled()).toBe(true);
  });
});
