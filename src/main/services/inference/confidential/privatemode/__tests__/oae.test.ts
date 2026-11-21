import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeOaeHeader, encodeOaeHeader, OaeError, openStream, openWhole, sealRequest } from '../oae';
import { frames, responder, SECRET } from './oaeResponder';

/**
 * The module against a stand-in responder (oaeResponder.ts) built on node:crypto, so a shared
 * mistake can't pass both sides.
 */

const MAX_FRAME = 1024 * 1024;

const APP_HEADER = { content_type: 'application/json', headers: { 'Privatemode-Version': 'v1.64.0' } };

describe('sealRequest', () => {
  it('seals a request the responder opens: header frame, then one final body frame', () => {
    const ex = sealRequest(SECRET, Buffer.from('{"model":"m"}'), APP_HEADER);
    expect(ex.requestHeader).toMatch(/^:[A-Za-z0-9+/]{43}=:$/);
    const opened = responder(ex.requestHeader).openRequest(ex.body);
    expect(opened).toEqual({ header: APP_HEADER, body: '{"model":"m"}' });
  });

  it('lays out each message as flag, 12-byte nonce, ciphertext and tag', () => {
    const body = Buffer.from('x'.repeat(10));
    const ex = sealRequest(SECRET, body, APP_HEADER);
    const [header, last] = frames(Buffer.from(ex.body));
    expect(header[0]).toBe(0);
    expect(last[0]).toBe(1);
    expect(last.length).toBe(1 + 12 + body.length + 16);
  });

  it('uses a fresh salt and nonce each time', () => {
    const a = sealRequest(SECRET, Buffer.from('same'), APP_HEADER);
    const b = sealRequest(SECRET, Buffer.from('same'), APP_HEADER);
    expect(a.requestHeader).not.toBe(b.requestHeader);
    expect(Buffer.from(a.body).equals(Buffer.from(b.body))).toBe(false);
  });

  it('refuses a secret that isn’t 32 bytes', () => {
    expect(() => sealRequest(Buffer.alloc(31), Buffer.from('x'), APP_HEADER)).toThrow(OaeError);
  });

  it('can’t be opened with another secret', () => {
    const ex = sealRequest(SECRET, Buffer.from('x'), APP_HEADER);
    expect(() => responder(ex.requestHeader, Buffer.alloc(32, 8)).openRequest(ex.body)).toThrow();
  });
});

describe('openWhole', () => {
  it('opens a unary reply and its app header', () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const server = responder(ex.requestHeader);
    const reply = server.unary('application/json', '{"choices":[]}');
    const opened = openWhole(ex.accept(server.responseHeader, MAX_FRAME), reply);
    expect(opened.appHeader).toEqual({ content_type: 'application/json' });
    expect(Buffer.from(opened.body).toString('utf8')).toBe('{"choices":[]}');
  });

  it('accepts a reply only once', () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const server = responder(ex.requestHeader);
    ex.accept(server.responseHeader, MAX_FRAME);
    expect(() => ex.accept(server.responseHeader, MAX_FRAME)).toThrow(OaeError);
  });

  function failsWith(build: (server: ReturnType<typeof responder>) => Buffer, header?: (server: ReturnType<typeof responder>) => string): void {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const server = responder(ex.requestHeader);
    const bytes = build(server);
    expect(() => openWhole(ex.accept(header ? header(server) : server.responseHeader, MAX_FRAME), bytes)).toThrow(OaeError);
  }

  it('fails a reply cut before its final frame', () => {
    failsWith((s) => s.seal(JSON.stringify({ content_type: 'application/json' }), false));
    failsWith((s) => s.unary('application/json', '{"a":1}').subarray(0, -3));
  });

  it('fails frames out of order', () => {
    failsWith((s) => {
      const header = s.seal('{}', false);
      const first = s.seal('a', false);
      const second = s.seal('b', false);
      return Buffer.concat([header, second, first, s.seal('', true)]);
    });
  });

  it('fails a reply with the final flag flipped', () => {
    failsWith((s) => {
      const bytes = Buffer.concat([s.seal('{}', false), s.seal('{}', true)]);
      const flipped = Buffer.from(bytes);
      flipped[4] = 1;
      return flipped;
    });
  });

  it('fails bytes after the final frame', () => {
    failsWith((s) => Buffer.concat([s.unary('application/json', '{}'), s.seal('more', false)]));
  });

  it('fails a reply sealed under another response salt', () => {
    failsWith(
      (s) => s.unary('application/json', '{}'),
      () => `:${randomBytes(32).toString('base64')}:`
    );
  });

  it('fails a frame longer than the limit', () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const server = responder(ex.requestHeader);
    expect(() => openWhole(ex.accept(server.responseHeader, 8), server.unary('application/json', '{}'))).toThrow(/frame too large/);
  });

  it('fails a header frame that isn’t a JSON object, and a header that is final', () => {
    failsWith((s) => Buffer.concat([s.seal('not json', false), s.seal('{}', true)]));
    failsWith((s) => s.seal('{}', true));
  });
});

describe('ResponseOpener frames', () => {
  it('opens the same messages whichever byte boundaries the chunks fall on', () => {
    const ex0 = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s0 = responder(ex0.requestHeader);
    const events = ['data: {"a":1}\n\n', 'data: {"b":"' + 'x'.repeat(300) + '"}\n\n', 'data: [DONE]\n\n'];
    const parts = (s: ReturnType<typeof responder>): Buffer =>
      Buffer.concat([s.seal(JSON.stringify({ content_type: 'text/event-stream' }), false), ...events.map((e) => s.seal(e, false)), s.seal('', true)]);
    const length = parts(s0).length;
    for (const size of [1, 2, 3, 5, 7, 31, length]) {
      const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
      const s = responder(ex.requestHeader);
      const all = parts(s);
      const opener = ex.accept(s.responseHeader, MAX_FRAME);
      const out: string[] = [];
      for (let at = 0; at < all.length; at += size) {
        for (const part of opener.push(new Uint8Array(all.subarray(at, at + size)))) out.push(Buffer.from(part).toString('utf8'));
      }
      opener.finish();
      expect([size, out]).toEqual([size, events]);
    }
  });

  it('reads one large frame fed in small chunks copying each byte about once', () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    const big = 'y'.repeat(256 * 1024);
    const reply = s.unary('application/json', big);
    const chunks: Uint8Array[] = [];
    for (let at = 0; at < reply.length; at += 16) chunks.push(new Uint8Array(reply.subarray(at, at + 16)));
    const opener = ex.accept(s.responseHeader, MAX_FRAME);
    // Counts the bytes copied with `set` while the chunks are pushed. Re-joining the buffer per
    // chunk copies about 2 GB here; reading each byte once copies about the frame's size.
    let copied = 0;
    const original = Uint8Array.prototype.set;
    const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (this: Uint8Array, array: ArrayLike<number>, offset?: number) {
      copied += array.length;
      original.call(this, array, offset);
    });
    const parts: Uint8Array[] = [];
    try {
      for (const chunk of chunks) parts.push(...opener.push(chunk));
    } finally {
      set.mockRestore();
    }
    opener.finish();
    expect(Buffer.concat(parts).toString('utf8')).toBe(big);
    expect(copied).toBeLessThan(4 * reply.length);
  });

  it('refuses a frame over the limit as soon as its length arrives', () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    const reply = s.unary('application/json', 'z'.repeat(2048));
    const opener = ex.accept(s.responseHeader, 1024);
    const headerFrame = 4 + frames(reply)[0].length;
    expect(opener.push(new Uint8Array(reply.subarray(0, headerFrame)))).toEqual([]);
    expect(() => opener.push(new Uint8Array(reply.subarray(headerFrame, headerFrame + 4)))).toThrow(OaeError);
  });
});

describe('decodeOaeHeader and encodeOaeHeader', () => {
  it('round-trips 32 bytes and rejects anything else', () => {
    const salt = randomBytes(32);
    expect(Buffer.from(decodeOaeHeader(encodeOaeHeader(salt))).equals(salt)).toBe(true);
    for (const bad of [null, '', 'abc', `:${randomBytes(16).toString('base64')}:`, `${salt.toString('base64')}`, ':!!!:']) {
      expect(() => decodeOaeHeader(bad)).toThrow(OaeError);
    }
  });
});

describe('openStream', () => {
  function body(chunks: Buffer[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c): void {
        for (const chunk of chunks) c.enqueue(new Uint8Array(chunk));
        c.close();
      },
    });
  }

  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  it('yields each event as its frame opens, split across chunks, ending at the empty final frame', async () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    const all = Buffer.concat([s.seal(JSON.stringify({ content_type: 'text/event-stream' }), false), s.seal('data: {"a":1}\n\n', false), s.seal('data: [DONE]\n\n', false), s.seal('', true)]);
    // Split at awkward points, inside a length prefix and inside a message.
    const chunks = [all.subarray(0, 2), all.subarray(2, 40), all.subarray(40, 41), all.subarray(41)];
    const opener = ex.accept(s.responseHeader, MAX_FRAME);
    expect(await readAll(openStream(opener, body(chunks)))).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(opener.appHeader).toEqual({ content_type: 'text/event-stream' });
  });

  it('errors and cancels the body when the stream ends without its final frame', async () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    const truncated = Buffer.concat([s.seal('{}', false), s.seal('data: {"a":1}\n\n', false)]);
    await expect(readAll(openStream(ex.accept(s.responseHeader, MAX_FRAME), body([truncated])))).rejects.toThrow(/truncated/);
  });

  it('errors on a frame that doesn’t authenticate and cancels the source', async () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    const event = s.seal('data: {"a":1}\n\n', false);
    event[event.length - 1] ^= 1;
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array(Buffer.concat([s.seal('{}', false), event])));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    await expect(readAll(openStream(ex.accept(s.responseHeader, MAX_FRAME), source))).rejects.toThrow(OaeError);
    expect(cancelled).toBe(true);
  });

  it('cancels the source when cancelled', async () => {
    const ex = sealRequest(SECRET, Buffer.from('{}'), APP_HEADER);
    const s = responder(ex.requestHeader);
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(new Uint8Array(Buffer.concat([s.seal('{}', false), s.seal('data: x\n\n', false)])));
      },
      cancel(): void {
        cancelled = true;
      },
    });
    const reader = openStream(ex.accept(s.responseHeader, MAX_FRAME), source).getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });
});
