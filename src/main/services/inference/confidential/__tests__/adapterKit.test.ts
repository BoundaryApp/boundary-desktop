import { describe, expect, it } from 'vitest';
import { plainRequest, readsAsContextOverflow, streamReply, UnsupportedContent } from '../adapterKit';
import type { AdapterFailure } from '../adapter';

/** An assistant tool call as Hermes v0.23.1 `_assistant_tool_call_dict` stores it, every optional key set. */
function hermesToolCall(): Record<string, unknown> {
  return {
    id: 'call_a1b2c3d4e5f6',
    call_id: 'call_a1b2c3d4e5f6',
    response_item_id: 'fc_a1b2c3d4e5f6',
    type: 'function',
    extra_content: { google: { thought_signature: 'SIGNATURE' } },
    function: { name: 'read_file', arguments: '{"path":"notes.md"}', thought_signature: 'SIGNATURE' },
  };
}

describe('plainRequest', () => {
  it('reduces a tool call to id, type and function name and arguments', () => {
    const out = plainRequest({
      model: 'm',
      messages: [{ role: 'assistant', content: null, tool_calls: [hermesToolCall()] }],
    }) as { messages: Array<{ tool_calls: unknown[] }> };
    expect(out.messages[0].tool_calls).toEqual([
      { id: 'call_a1b2c3d4e5f6', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } },
    ]);
    expect(JSON.stringify(out)).not.toContain('SIGNATURE');
  });

  it('keeps a tool call without an id', () => {
    const out = plainRequest({
      messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'x', arguments: '{}' } }] }],
    }) as { messages: Array<{ tool_calls: unknown[] }> };
    expect(out.messages[0].tool_calls).toEqual([{ type: 'function', function: { name: 'x', arguments: '{}' } }]);
  });

  it('refuses a tool call that is not a function call with an object function and a string id', () => {
    const calls: unknown[] = [
      'call_1',
      { id: 'c1', type: 'custom', custom: { name: 'x', input: 'secret' } },
      { id: 'c1', function: { name: 'x', arguments: '{}' } },
      { id: 'c1', type: 'function', function: 'x' },
      { id: 7, type: 'function', function: { name: 'x', arguments: '{}' } },
    ];
    for (const call of calls) {
      const body = { messages: [{ role: 'assistant', content: null as string | null, tool_calls: [call] }] };
      expect(() => plainRequest(body), JSON.stringify(call)).toThrow(UnsupportedContent);
    }
  });
});

describe('readsAsContextOverflow', () => {
  it('reads a request error body about the context length, and nothing else', () => {
    for (const body of [
      '{"error":{"code":"context_length_exceeded"}}',
      'This model\'s maximum context length is 32768 tokens',
      'prompt is too long: 140000 tokens > 131072 maximum',
      'The input (140000 tokens) is longer than the model\'s context length (131072 tokens).',
      'Input length 131393 exceeds the max_model_len 131072',
    ]) {
      expect(readsAsContextOverflow(400, body), body).toBe(true);
    }
    expect(readsAsContextOverflow(413, 'context length exceeded')).toBe(true);
    expect(readsAsContextOverflow(400, '{"error":{"message":"Invalid tool schema"}}')).toBe(false);
    expect(readsAsContextOverflow(500, 'maximum context length')).toBe(false);
    expect(readsAsContextOverflow(401, 'maximum context length')).toBe(false);
  });
});

describe('streamReply', () => {
  const sse = (text: string): Response => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const pass = (event: { data: string }): string => event.data;
  /** Whether `failed` has settled once the body has been read and the microtasks run. */
  async function settled(failed: Promise<AdapterFailure> | undefined): Promise<AdapterFailure | 'pending'> {
    return Promise.race([failed ?? Promise.resolve('pending' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 0))]);
  }

  it('reports a reply that breaks after its head, and drops the cache once', async () => {
    let dropped = 0;
    const result = streamReply(sse('data: {"a":1}\n\n'), pass, new AbortController().signal, () => (dropped += 1));
    if (result.ok === false) throw new Error('expected a reply');
    await result.response.text();
    expect(await settled(result.failed)).toEqual({ kind: 'mid-stream', detail: 'stream' });
    expect(dropped).toBe(1);
  });

  it('leaves `failed` pending for a reply that ends at [DONE], or that the caller aborts', async () => {
    const done = streamReply(sse('data: {"a":1}\n\ndata: [DONE]\n\n'), pass, new AbortController().signal, () => undefined);
    if (done.ok === false) throw new Error('expected a reply');
    await done.response.text();
    expect(await settled(done.failed)).toBe('pending');

    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start: () => undefined });
    const aborted = streamReply(new Response(body), pass, abort.signal, () => undefined);
    if (aborted.ok === false) throw new Error('expected a reply');
    const read = aborted.response.text().catch(() => 'aborted');
    abort.abort();
    expect(await read).toBe('aborted');
    expect(await settled(aborted.failed)).toBe('pending');
  });
});
