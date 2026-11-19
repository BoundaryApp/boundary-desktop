import { describe, expect, it, vi } from 'vitest';
import { meterUsage } from '../usageMeter';

const encoder = new TextEncoder();
const usage = { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 600 } };

/** A body that hands out the given chunks one per pull, then ends. */
function body(chunks: Array<string | Uint8Array>, extra: { cancel?: (reason: unknown) => void } = {}): ReadableStream<Uint8Array> {
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: extra.cancel,
    },
    { highWaterMark: 0 }
  );
}

function sse(chunks: Array<string | Uint8Array>, extra?: { cancel?: (reason: unknown) => void }): Response {
  return new Response(body(chunks, extra), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function bytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function concat(chunks: string[]): Uint8Array {
  return encoder.encode(chunks.join(''));
}

const content = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }], usage: null })}\n\n`;
const final = `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
const done = 'data: [DONE]\n\n';

describe('meterUsage', () => {
  it('passes an SSE body through byte for byte and reports its usage once', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const metered = meterUsage(sse([content, final, done]), onDone);
    expect(await bytes(metered)).toEqual(concat([content, final, done]));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('keeps each chunk as the source sent it', async () => {
    const metered = meterUsage(sse([content, final, done]), vi.fn());
    const reader = metered.body!.getReader();
    const seen: string[] = [];
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) break;
      seen.push(new TextDecoder().decode(value));
    }
    expect(seen).toEqual([content, final, done]);
  });

  it('reads usage split across chunks', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const cut = final.indexOf('prompt_tokens') + 4;
    await bytes(meterUsage(sse([content, final.slice(0, cut), final.slice(cut), done]), onDone));
    expect(onDone).toHaveBeenCalledWith(usage);

    const crlf = vi.fn<(usage: unknown) => void>();
    const crlfFinal = final.replace(/\n/g, '\r\n');
    const crlfCut = crlfFinal.indexOf('completion') + 3;
    await bytes(meterUsage(sse([crlfFinal.slice(0, crlfCut), crlfFinal.slice(crlfCut), 'data: [DONE]\r\n\r\n']), crlf));
    expect(crlf).toHaveBeenCalledWith(usage);
  });

  it('reads usage split inside a multi-byte character', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const line = encoder.encode(`data: ${JSON.stringify({ choices: [], note: 'café', usage })}\n\n`);
    const cut = line.indexOf(0xc3) + 1;
    await bytes(meterUsage(sse([line.slice(0, cut), line.slice(cut)]), onDone));
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('reports the last usage when two chunks carry one', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const earlier = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`;
    await bytes(meterUsage(sse([earlier, final, done]), onDone));
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('reads the usage of a final line without a newline', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    await bytes(meterUsage(sse([content, final.trimEnd()]), onDone));
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('reads a JSON body’s usage', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const text = JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }], usage });
    const response = Response.json(JSON.parse(text));
    const metered = meterUsage(response, onDone);
    expect(await metered.text()).toBe(text);
    expect(onDone).toHaveBeenCalledWith(usage);
  });

  it('gives up on a JSON body over 2 MB but still passes it through', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const text = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(2 * 1024 * 1024) } }], usage });
    const cut = Math.floor(text.length / 2);
    const response = new Response(body([text.slice(0, cut), text.slice(cut)]), { headers: { 'content-type': 'application/json' } });
    const metered = meterUsage(response, onDone);
    expect(await metered.text()).toBe(text);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('reports null when nothing carries usage', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    await bytes(meterUsage(sse([content, 'data: not json "usage"\n\n', done]), onDone));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('cancel reaches the source and records once', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const sourceCancel = vi.fn();
    const metered = meterUsage(sse([content, final, done], { cancel: sourceCancel }), onDone);
    const reader = metered.body!.getReader();
    await reader.read();
    await reader.cancel('client closed');
    expect(sourceCancel).toHaveBeenCalledWith('client closed');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('cancelling the body without reading it reaches the source', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const sourceCancel = vi.fn();
    const metered = meterUsage(sse([content], { cancel: sourceCancel }), onDone);
    await metered.body!.cancel();
    expect(sourceCancel).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('rejects the reader when the source errors, and records once', async () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    let pulls = 0;
    const failing = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) controller.enqueue(encoder.encode(content));
          else controller.error(new Error('reset'));
        },
      },
      { highWaterMark: 0 }
    );
    const metered = meterUsage(new Response(failing, { headers: { 'content-type': 'text/event-stream' } }), onDone);
    const reader = metered.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow('reset');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('keeps status, status text and headers', () => {
    const response = new Response(body([content]), {
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'abc' },
    });
    const metered = meterUsage(response, vi.fn());
    expect(metered.status).toBe(201);
    expect(metered.statusText).toBe('Created');
    expect(metered.headers.get('content-type')).toBe('text/event-stream');
    expect(metered.headers.get('x-request-id')).toBe('abc');
  });

  it('reports null at once for a response without a body', () => {
    const onDone = vi.fn<(usage: unknown) => void>();
    const response = new Response(null, { status: 204 });
    expect(meterUsage(response, onDone).status).toBe(204);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(null);
  });

  it('still finishes the stream when onDone throws', async () => {
    const metered = meterUsage(sse([content, done]), () => {
      throw new Error('store full');
    });
    expect(await bytes(metered)).toEqual(concat([content, done]));
  });
});
