import { describe, expect, it } from 'vitest';
import { plainChatRequest, plainRequest, readsAsContextOverflow, replyObject, settleOrAbort, streamReply, UnsupportedContent } from '../adapterKit';
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

describe('plainChatRequest', () => {
  it('keeps the fields NEAR gets, unsealed, and drops the rest', () => {
    const out = plainChatRequest({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true, extra: 'x' },
      temperature: 0.2,
      max_tokens: 'lots',
      reasoning_effort: 'high',
      logprobs: true,
      user: 'someone',
      metadata: { note: 'leak' },
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: null, reasoning_content: 'earlier thinking', tool_calls: [hermesToolCall()] },
        { role: 'tool', tool_call_id: 'call_a1b2c3d4e5f6', content: 'file text' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Reads', parameters: { type: 'object' }, strict: true }, extra: 1 }],
      tool_choice: { type: 'function', function: { name: 'read_file', extra: 1 } },
    });
    expect(out).toEqual({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a1b2c3d4e5f6', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }] },
        { role: 'tool', tool_call_id: 'call_a1b2c3d4e5f6', content: 'file text' },
      ],
      tools: [{ type: 'function', function: { name: 'read_file', description: 'Reads', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    });
  });

  it('keeps a listed tool_choice mode and drops another string', () => {
    expect(plainChatRequest({ model: 'm', tool_choice: 'required' }).tool_choice).toBe('required');
    expect(plainChatRequest({ model: 'm', tool_choice: 'whatever' })).not.toHaveProperty('tool_choice');
  });

  it.each([
    ['stop', { stop: ['x'] }],
    ['functions', { functions: [] }],
    ['prediction', { prediction: { type: 'content', content: 'x' } }],
    ['a json_schema response format', { response_format: { type: 'json_schema', json_schema: {} } }],
    ['tools that aren’t a list', { tools: {} }],
    ['a tool that isn’t a function', { tools: [{ type: 'web_search' }] }],
    ['an image part', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }],
    ['a tool_choice object of another type', { tool_choice: { type: 'web_search' } }],
  ])('refuses %s', (_name, extra) => {
    expect(() => plainChatRequest({ model: 'm', ...extra })).toThrow(UnsupportedContent);
  });
});

describe('replyObject', () => {
  const reply = {
    id: 'c1',
    object: 'chat.completion',
    model: 'm',
    usage: { prompt_tokens: 3 },
    extra: 'dropped',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: { content: [] as unknown[] },
        message: {
          role: 'assistant',
          content: 'hi',
          reasoning_content: 'why',
          audio: { data: 'x' },
          tool_calls: [{ index: 0, id: 't1', type: 'function', extra: 1, function: { name: 'f', arguments: '{}', extra: 1 } }],
        },
      },
    ],
  };

  it('keeps only the listed fields and passes text as is by default', () => {
    expect(replyObject(reply)).toEqual({
      id: 'c1',
      object: 'chat.completion',
      model: 'm',
      usage: { prompt_tokens: 3 },
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'hi', reasoning_content: 'why', tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        },
      ],
    });
  });

  it('runs each non-empty text field through open', () => {
    const out = replyObject({ choices: [{ delta: { content: 'a', refusal: '', tool_calls: [{ function: { arguments: 'b' } }] } }] }, (v) => v.toUpperCase());
    expect(out).toEqual({ choices: [{ delta: { content: 'A', refusal: '', tool_calls: [{ function: { arguments: 'B' } }] } }] });
  });

  it('throws on a text field that isn’t a string', () => {
    expect(() => replyObject({ choices: [{ message: { content: { text: 'x' } } }] })).toThrow();
  });
});

describe('settleOrAbort', () => {
  it('resolves done, failed or aborted and never rejects', async () => {
    expect(await settleOrAbort(Promise.resolve(1), new AbortController().signal)).toEqual({ kind: 'done', value: 1 });
    expect(await settleOrAbort(Promise.reject(new Error('x')), new AbortController().signal)).toEqual({ kind: 'failed' });
    const controller = new AbortController();
    const pending = settleOrAbort(new Promise<number>(() => undefined), controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });
});
