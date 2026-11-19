import {
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { describe, expect, it } from 'vitest';
import { UnsupportedContent } from '../../adapterKit';
import {
  decryptField,
  decryptReplyObject,
  encryptField,
  encryptRequest,
  nearHeaders,
  newClientKeys,
  type NearClientKeys,
} from '../nearCrypto';

const HEX = /^[0-9a-f]+$/;

// DER prefixes for raw 32-byte keys, so node:crypto can work on them.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

function x25519Private(raw: Buffer): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function x25519Public(raw: Buffer): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** libsodium's crypto_sign_ed25519_sk_to_curve25519: clamped SHA-512 of the Ed25519 seed. */
function sodiumX25519Secret(seed: Uint8Array): Buffer {
  const secret = createHash('sha512').update(seed).digest().subarray(0, 32);
  secret[0] &= 248;
  secret[31] &= 127;
  secret[31] |= 64;
  return secret;
}

/** A model keypair built with node:crypto alone; the X25519 secret is libsodium's sk_to_curve25519. */
function nodeModelKey(): { ed25519PubHex: string; x25519Secret: Buffer } {
  const seed = Buffer.alloc(32, 7);
  const edPriv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(edPriv).export({ format: 'der', type: 'spki' });
  const x25519Secret = sodiumX25519Secret(seed);
  return {
    ed25519PubHex: spki.subarray(spki.length - 32).toString('hex'),
    x25519Secret,
  };
}

function decryptsTo(value: unknown, keys: NearClientKeys): string {
  expect(typeof value).toBe('string');
  expect(value as string).toMatch(HEX);
  return decryptField(value as string, keys);
}

describe('nearCrypto', () => {
  it('round-trips a field to a model key and back', () => {
    const model = newClientKeys();
    expect(model.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    const wire = encryptField('Hello, enclave. Ünïcødé ✓', model.publicKeyHex);
    expect(wire).toMatch(HEX);
    expect(wire.length).toBe((32 + 24 + Buffer.byteLength('Hello, enclave. Ünïcødé ✓') + 16) * 2);
    expect(decryptField(wire, model)).toBe('Hello, enclave. Ünïcødé ✓');
    expect(encryptField('same', model.publicKeyHex)).not.toBe(encryptField('same', model.publicKeyHex));
  });

  it('derives the key as NEAR documents', () => {
    const model = nodeModelKey();
    const wire = Buffer.from(encryptField('pinned layout', model.ed25519PubHex), 'hex');
    const eph = wire.subarray(0, 32);
    const nonce = wire.subarray(32, 56);
    const ct = wire.subarray(56);
    const shared = diffieHellman({
      privateKey: x25519Private(model.x25519Secret),
      publicKey: x25519Public(eph),
    });
    const key = new Uint8Array(hkdfSync('sha256', shared, Buffer.alloc(0), 'ed25519_encryption', 32));
    const plain = xchacha20poly1305(key, nonce).decrypt(ct);
    expect(Buffer.from(plain).toString('utf8')).toBe('pinned layout');
  });

  it('encrypts tool history in the request', () => {
    const model = newClientKeys();
    const schema = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    };
    const body = {
      model: 'z-ai/glm-5.3-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Weather in Oslo?', name: 'kit' },
        {
          role: 'assistant',
          content: null as string | null,
          refusal: 'no',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":4}' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Weather by city',
            parameters: schema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    };
    const original = structuredClone(body);
    const out = encryptRequest(body, model.publicKeyHex) as typeof body;

    expect(body).toEqual(original);
    expect(out.model).toBe(body.model);
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });

    const [system, user, assistant, tool] = out.messages;
    expect(system.role).toBe('system');
    expect(decryptsTo(system.content, model)).toBe('Be brief.');
    expect(decryptsTo(user.content, model)).toBe('Weather in Oslo?');
    expect(decryptsTo(user.name, model)).toBe('kit');
    expect(assistant.content).toBeNull();
    expect(decryptsTo(assistant.refusal, model)).toBe('no');
    const call = assistant.tool_calls[0];
    expect(call.id).toBe('call_1');
    expect(Object.keys(call).sort()).toEqual(['function', 'id', 'type']);
    expect(call.type).toBe('function');
    expect(decryptsTo(call.function.name, model)).toBe('get_weather');
    expect(decryptsTo(call.function.arguments, model)).toBe('{"city":"Oslo"}');
    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_1');
    expect(decryptsTo(tool.content, model)).toBe('{"temp":4}');

    const fn = out.tools[0].function;
    expect(out.tools[0].type).toBe('function');
    expect(decryptsTo(fn.name, model)).toBe('get_weather');
    expect(decryptsTo(fn.description, model)).toBe('Weather by city');
    expect(decryptsTo(fn.parameters, model)).toBe(JSON.stringify(schema));
    expect(out.tool_choice.type).toBe('function');
    expect(decryptsTo(out.tool_choice.function.name, model)).toBe('get_weather');
  });

  it('leaves a string tool_choice plain', () => {
    const model = newClientKeys();
    const out = encryptRequest({ model: 'm', messages: [], tool_choice: 'auto' }, model.publicKeyHex);
    expect(out.tool_choice).toBe('auto');
    const other = encryptRequest({ model: 'm', messages: [], tool_choice: 'secret' }, model.publicKeyHex);
    expect(other).not.toHaveProperty('tool_choice');
  });

  it('joins text parts and refuses an image part', () => {
    const model = newClientKeys();
    const out = encryptRequest(
      {
        model: 'm',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'first' },
              { type: 'text', text: 'second' },
            ],
          },
        ],
      },
      model.publicKeyHex,
    ) as { messages: Array<{ content: unknown }> };
    expect(decryptsTo(out.messages[0].content, model)).toBe('first\n\nsecond');

    const withImage = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA' },
            },
          ],
        },
      ],
    };
    expect(() => encryptRequest(withImage, model.publicKeyHex)).toThrow(UnsupportedContent);
  });

  it('decrypts message and delta fields and leaves usage plain', () => {
    const client = newClientKeys();
    const enc = (s: string): string => encryptField(s, client.publicKeyHex);
    const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
    const completion = {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: enc('Checking.'),
            reasoning_content: enc('think'),
            reasoning: enc('think more'),
            refusal: null as string | null,
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: {
                  name: enc('get_weather'),
                  arguments: enc('{"city":"Oslo"}'),
                },
              },
            ],
          },
        },
      ],
      usage,
    };
    const out = decryptReplyObject(completion, client) as typeof completion;
    const message = out.choices[0].message;
    expect(out.id).toBe('chatcmpl-1');
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.usage).toEqual(usage);
    expect(message.content).toBe('Checking.');
    expect(message.reasoning_content).toBe('think');
    expect(message.reasoning).toBe('think more');
    expect(message.refusal).toBeNull();
    expect(message.tool_calls[0]).toEqual({
      id: 'call_9',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Oslo"}' },
    });
    expect(completion.choices[0].message.content).not.toBe('Checking.');

    const chunk = {
      id: 'chatcmpl-2',
      choices: [
        {
          index: 0,
          finish_reason: null as string | null,
          delta: {
            content: '',
            tool_calls: [{ index: 0, function: { arguments: enc('{"ci') } }],
          },
        },
        {
          index: 1,
          finish_reason: null as string | null,
          delta: { content: enc('Hi') },
        },
      ],
    };
    const outChunk = decryptReplyObject(chunk, client) as typeof chunk;
    expect(outChunk.choices[0].delta.content).toBe('');
    expect(outChunk.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      function: { arguments: '{"ci' },
    });
    expect(outChunk.choices[1].delta.content).toBe('Hi');

    const usageChunk = { id: 'chatcmpl-2', choices: [] as unknown[], usage };
    expect(decryptReplyObject(usageChunk, client)).toEqual(usageChunk);
  });

  it('passes on only the reply fields it knows, so nothing NEAR sends plain reaches Hermes as model output', () => {
    const client = newClientKeys();
    const enc = (s: string): string => encryptField(s, client.publicKeyHex);
    const usage = { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
    const reply = {
      id: 'chatcmpl-3',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      system_fingerprint: 'fp',
      usage,
      prompt_logprobs: [{ token: 'plain prompt text' }],
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          stop_reason: 'plain stop text',
          logprobs: { content: [{ token: 'plain token' }] },
          message: {
            role: 'assistant',
            content: enc('Hi'),
            function_call: { name: 'plain_fn', arguments: '{}' },
            nearai_tool_result: 'plain tool result',
            audio: { data: 'plain' },
            tool_calls: [
              { index: 0, id: 'c1', type: 'function', extra: 'plain', function: { name: enc('f'), arguments: enc('{}'), extra: 'plain' } },
            ],
          },
        },
      ],
    };
    expect(decryptReplyObject(reply, client)).toEqual({
      id: 'chatcmpl-3',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      system_fingerprint: 'fp',
      usage,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Hi',
            tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
        },
      ],
    });
  });

  it("throws on a non-empty field that isn't valid v2", () => {
    const client = newClientKeys();
    const other = newClientKeys();
    const reply = (content: string): Record<string, unknown> => ({
      choices: [{ index: 0, delta: { content } }],
    });

    const plain = 'Hello there';
    const odd = 'abc';
    const short = 'ab'.repeat(32 + 24 + 15);
    const wrongKey = encryptField('secret reply', other.publicKeyHex);
    for (const bad of [plain, odd, short, wrongKey]) {
      expect(() => decryptField(bad, client)).toThrow();
      expect(() => decryptReplyObject(reply(bad), client)).toThrow();
    }
    expect(() => decryptReplyObject({ choices: [{ index: 0, delta: { content: 42 } }] }, client)).toThrow();

    let message = '';
    try {
      decryptField(wrongKey, client);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain('secret reply');
    expect(message).not.toContain(wrongKey.slice(0, 64));
    expect(message).not.toContain(Buffer.from(client.secretKey).toString('hex'));
  });

  it('sends the documented headers', () => {
    const client = newClientKeys();
    const modelKey = 'ab'.repeat(32);
    expect(nearHeaders(client, modelKey)).toEqual({
      'X-Signing-Algo': 'ed25519',
      'X-Client-Pub-Key': client.publicKeyHex,
      'X-Model-Pub-Key': modelKey,
      'X-Encryption-Version': '2',
      'X-Encrypt-All-Fields': 'true',
    });
  });

  it('opens a reply vector built with node:crypto', () => {
    const client = newClientKeys();
    const clientX25519 = x25519Private(sodiumX25519Secret(client.secretKey));
    const clientPub = createPublicKey(clientX25519).export({ format: 'der', type: 'spki' }).subarray(-32);
    const eph = generateKeyPairSync('x25519');
    const ephPub = eph.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(clientPub) });
    const key = new Uint8Array(hkdfSync('sha256', shared, Buffer.alloc(0), 'ed25519_encryption', 32));
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(key, nonce).encrypt(new TextEncoder().encode('reply from the enclave ✓'));
    const wire = Buffer.concat([ephPub, nonce, ct]).toString('hex');
    expect(decryptField(wire, client)).toBe('reply from the enclave ✓');
  });

  it('refuses request content and fields NEAR leaves plain', () => {
    const model = newClientKeys();
    const fn = { name: 'get_weather', arguments: '{}' };
    const bodies: Array<Record<string, unknown>> = [
      { messages: [{ role: 'user', content: { text: 'an object' } }] },
      { messages: [{ role: 'user', content: 42 }] },
      {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'custom', custom: { name: 'x', input: 'secret' } }],
          },
        ],
      },
      { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: fn }] }] },
      { messages: [{ role: 'assistant', content: null, tool_calls: { id: 'c1' } }] },
      { messages: ['plain string message'] },
      { messages: [], tools: [{ type: 'custom', custom: { name: 'x', description: 'secret' } }] },
      {
        messages: [],
        tool_choice: {
          type: 'allowed_tools',
          allowed_tools: { tools: [{ type: 'function', function: { name: 'x' } }] },
        },
      },
    ];
    for (const body of bodies) {
      expect(() => encryptRequest({ model: 'm', ...body }, model.publicKeyHex)).toThrow(UnsupportedContent);
    }
    const allowed = encryptRequest(
      { model: 'm', messages: [{ role: 'assistant', content: 'ok', function_call: null, audio: null }] },
      model.publicKeyHex,
    ) as { messages: Array<{ content: unknown }> };
    expect(decryptsTo(allowed.messages[0].content, model)).toBe('ok');
  });

  it('drops replayed reasoning and seals the rest of a Hermes history', () => {
    const model = newClientKeys();
    const marker = 'REASONINGMARKER';
    const body = {
      model: 'z-ai/glm-5.3-flash',
      messages: [
        { role: 'user', content: 'Weather in Oslo?' },
        {
          role: 'assistant',
          content: '',
          reasoning_content: `${marker} one`,
          reasoning: `${marker} two`,
          reasoning_details: [{ type: 'reasoning.text', text: `${marker} three` }],
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":4}' },
      ],
    };
    const out = encryptRequest(body, model.publicKeyHex) as { messages: Array<Record<string, unknown>> };
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(marker);
    expect(wire).not.toContain('Oslo');
    expect(wire).not.toContain('get_weather');
    const assistant = out.messages[1];
    expect(Object.keys(assistant).sort()).toEqual(['content', 'role', 'tool_calls']);
    expect(out.messages[2].tool_call_id).toBe('call_1');
    expect(decryptsTo(out.messages[2].content, model)).toBe('{"temp":4}');
  });

  it('replaces tool call ids with aliases numbered by first appearance', () => {
    const model = newClientKeys();
    const call = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{}' } });
    const body = {
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [call('call_9f86d081884c', 'a'), call('toolu_01XYZ', 'b')] },
        { role: 'tool', tool_call_id: 'toolu_01XYZ', content: 'b done' },
        { role: 'tool', tool_call_id: 'call_9f86d081884c', content: 'a done' },
        { role: 'assistant', content: null as string | null, tool_calls: [{ type: 'function', function: { name: 'c', arguments: '{}' } }, call('call_fresh', 'd')] },
        { role: 'tool', tool_call_id: 'orphan_id', content: 'd done' },
      ],
    };
    const out = encryptRequest(body, model.publicKeyHex) as { messages: Array<Record<string, any>> };
    const wire = JSON.stringify(out);
    for (const id of ['9f86d081884c', 'toolu_01XYZ', 'call_fresh', 'orphan_id']) expect(wire).not.toContain(id);
    expect(out.messages[0].tool_calls.map((c: { id: string }) => c.id)).toEqual(['call_1', 'call_2']);
    expect(out.messages[1].tool_call_id).toBe('call_2');
    expect(out.messages[2].tool_call_id).toBe('call_1');
    expect('id' in out.messages[3].tool_calls[0]).toBe(false);
    expect(out.messages[3].tool_calls[1].id).toBe('call_3');
    expect(out.messages[4].tool_call_id).toBe('call_4');
  });

  it('sends a Hermes tool call as id, type and sealed function name and arguments only', () => {
    const model = newClientKeys();
    const body = {
      model: 'google/gemma-3-27b-it',
      messages: [
        {
          role: 'assistant',
          content: null as string | null,
          tool_calls: [
            {
              id: 'call_a1b2c3d4e5f6',
              call_id: 'call_a1b2c3d4e5f6',
              response_item_id: 'fc_a1b2c3d4e5f6',
              type: 'function',
              extra_content: { google: { thought_signature: 'SIGNATURE' } },
              function: { name: 'read_file', arguments: '{"path":"notes.md"}', thought_signature: 'SIGNATURE' },
            },
          ],
        },
      ],
    };
    const out = encryptRequest(body, model.publicKeyHex) as { messages: Array<Record<string, any>> };
    const call = out.messages[0].tool_calls[0];
    expect(Object.keys(call).sort()).toEqual(['function', 'id', 'type']);
    expect(Object.keys(call.function).sort()).toEqual(['arguments', 'name']);
    expect(JSON.stringify(out)).not.toMatch(/SIGNATURE|a1b2c3d4e5f6|read_file|notes/);
  });

  it('drops message fields outside the allowlist', () => {
    const model = newClientKeys();
    const body = {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi', metadata: { note: 'secret' }, finish_reason: 'stop' },
        { role: 'assistant', content: null as string | null, function_call: { name: 'secret_fn', arguments: '{}' }, audio: { id: 'secret_audio' } },
      ],
    };
    const out = encryptRequest(body, model.publicKeyHex) as { messages: Array<Record<string, unknown>> };
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(Object.keys(out.messages[0]).sort()).toEqual(['content', 'role']);
    expect(Object.keys(out.messages[1]).sort()).toEqual(['content', 'role']);
  });

  it('refuses non-string text fields and unsupported request shapes', () => {
    const model = newClientKeys();
    const call = (fn: Record<string, unknown>) => [{ id: 'c1', type: 'function', function: fn }];
    const bodies: Array<Record<string, unknown>> = [
      { messages: [{ role: 'user', content: 'hi', name: 42 }] },
      { messages: [{ role: 'assistant', content: null, refusal: { text: 'secret' } }] },
      { messages: [{ role: 'tool', content: 'x', tool_call_id: 7 }] },
      { messages: [{ content: 'no role' }] },
      { messages: [{ role: 'assistant', content: null, tool_calls: call({ name: 1, arguments: '{}' }) }] },
      { messages: [{ role: 'assistant', content: null, tool_calls: call({ name: 'x', arguments: { city: 'Oslo' } }) }] },
      { messages: { role: 'user', content: 'not a list' } },
      { messages: [], tools: { type: 'function', function: { name: 'x' } } },
      { messages: [], tools: [{ type: 'function', function: { name: 'x', description: ['secret'] } }] },
      { messages: [], functions: [{ name: 'x', description: 'secret' }] },
      { messages: [], prediction: { type: 'content', content: 'secret' } },
    ];
    for (const body of bodies) {
      expect(() => encryptRequest({ model: 'm', ...body }, model.publicKeyHex), JSON.stringify(body)).toThrow(UnsupportedContent);
    }
    const nullFields = encryptRequest(
      { model: 'm', messages: [{ role: 'user', content: 'ok', metadata: null, name: null }], functions: null, prediction: null },
      model.publicKeyHex,
    ) as { messages: Array<Record<string, unknown>> };
    expect(Object.keys(nullFields.messages[0]).sort()).toEqual(['content', 'name', 'role']);
  });

  it('sends only allowlisted top-level fields', () => {
    const model = newClientKeys();
    // The fields Hermes v0.23.1 puts on a chat request, plus OpenAI fields that carry text or ids.
    const body = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true, secret: 'secret' },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 100,
      max_completion_tokens: 100,
      n: 1,
      presence_penalty: 0,
      frequency_penalty: 0.5,
      seed: 7,
      parallel_tool_calls: false,
      reasoning_effort: 'high',
      reasoning: { enabled: true, effort: 'medium', note: 'secret' },
      chat_template_kwargs: { enable_thinking: false, system_hint: 'secret' },
      response_format: { type: 'json_object' },
      prompt_cache_key: 'secret-cache-key',
      user: 'secret-user',
      metadata: { session: 'secret' },
      logit_bias: { 50256: -100 },
      store: true,
      service_tier: 'auto',
      extra_body: { provider: 'secret' },
      tags: ['secret'],
    };
    const out = encryptRequest(body, model.publicKeyHex);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(Object.keys(out).sort()).toEqual(
      [
        'chat_template_kwargs',
        'frequency_penalty',
        'max_completion_tokens',
        'max_tokens',
        'messages',
        'model',
        'n',
        'parallel_tool_calls',
        'presence_penalty',
        'reasoning',
        'reasoning_effort',
        'response_format',
        'seed',
        'stream',
        'stream_options',
        'temperature',
        'top_p',
      ].sort(),
    );
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.reasoning).toEqual({ enabled: true, effort: 'medium' });
    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(out.response_format).toEqual({ type: 'json_object' });
    expect(out.temperature).toBe(0.2);
    expect(out.reasoning_effort).toBe('high');
  });

  it('drops allowlisted fields of the wrong type', () => {
    const model = newClientKeys();
    const out = encryptRequest(
      {
        model: 'm',
        messages: [],
        temperature: 'secret',
        stream: 'secret',
        reasoning_effort: 'secret effort words',
        reasoning: 'secret',
        stream_options: 'secret',
        chat_template_kwargs: ['secret'],
      },
      model.publicKeyHex,
    );
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(Object.keys(out).sort()).toEqual(['messages', 'model']);
  });

  it('refuses top-level fields that would change the reply if dropped', () => {
    const model = newClientKeys();
    const bodies: Array<Record<string, unknown>> = [
      { stop: ['secret'] },
      { stop: 'secret' },
      { response_format: { type: 'json_schema', json_schema: { name: 'secret', schema: {} } } },
      { response_format: { type: 'grammar', grammar: 'secret' } },
      { response_format: 'json_object' },
      { model: 42 },
    ];
    for (const body of bodies) {
      expect(() => encryptRequest({ model: 'm', messages: [], ...body }, model.publicKeyHex), JSON.stringify(body)).toThrow(
        UnsupportedContent,
      );
    }
    const nulls = encryptRequest({ model: 'm', messages: [], stop: null, response_format: null }, model.publicKeyHex);
    expect(Object.keys(nulls).sort()).toEqual(['messages', 'model']);
    const text = encryptRequest({ model: 'm', messages: [], response_format: { type: 'text' } }, model.publicKeyHex);
    expect(text.response_format).toEqual({ type: 'text' });
  });

  it('validates and lowercases the model key', () => {
    const client = newClientKeys();
    const model = newClientKeys();
    const upper = model.publicKeyHex.toUpperCase();
    expect(nearHeaders(client, upper)['X-Model-Pub-Key']).toBe(model.publicKeyHex);
    expect(decryptField(encryptField('mixed case', upper), model)).toBe('mixed case');
    for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(31)}zz`, ` ${model.publicKeyHex}`]) {
      expect(() => nearHeaders(client, bad)).toThrow('NEAR model key isn’t a 32-byte hex value');
      expect(() => encryptField('x', bad)).toThrow('NEAR model key isn’t a 32-byte hex value');
    }
  });
});
