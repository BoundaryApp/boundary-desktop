/**
 * Privatemode's full-body encryption: Online Authenticated Encryption (OAE) of a request and its
 * response, as `internal/oss/oae` and `internal/oss/encbody` in edgelesssys/privatemode-public
 * implement it (MIT).
 *
 * Keys: PRK = HKDF-Extract(SHA-256, ikm = the 32-byte secret, salt = a random 32-byte request
 * salt). The request key is HKDF-Expand(PRK, "privatemode oae request key\0", 32); the response
 * key is HKDF-Expand(PRK, "privatemode oae response key\0" || response salt, 32), the response
 * salt coming from the reply's `Privatemode-OAE-Response-Header`.
 *
 * Messages: `flag(1) || nonce(12) || AES-256-GCM ciphertext and tag`, where the flag is 1 on the
 * final message of a stream and 0 otherwise, and the AAD is the message's sequence number (u32,
 * big-endian, from 0) followed by the flag byte. A body is a run of frames, each a u32 big-endian
 * length and one message. The first frame is an app header `{content_type, headers}` in JSON; a
 * whole body follows it with one final frame, a server-sent event stream with one frame per event
 * (the event's raw bytes) and an empty final frame. A body that ends before its final frame is
 * truncated and fails, as does anything after it.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const ENCRYPTED_CONTENT_TYPE = 'application/vnd.privatemode.encrypted-body';
const SECRET_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;
const MAX_MESSAGES = 2 ** 32;
const REQUEST_INFO = utf8ToBytes('privatemode oae request key\0');
const RESPONSE_INFO_PREFIX = utf8ToBytes('privatemode oae response key\0');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A failure to open a body. Its message is fixed and quotes nothing from the body. */
export class OaeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OaeError';
  }
}

export interface AppHeader {
  content_type?: string;
  headers?: Record<string, string>;
}

function aad(seq: number, flag: number): Uint8Array {
  const out = new Uint8Array(5);
  new DataView(out.buffer).setUint32(0, seq, false);
  out[4] = flag;
  return out;
}

/** One direction's messages, sealed or opened in order. */
class Stream {
  private seq = 0;
  private closed = false;
  constructor(private readonly key: Uint8Array) {}

  seal(plaintext: Uint8Array, final: boolean): Uint8Array {
    if (this.closed) throw new OaeError('stream closed');
    if (this.seq >= MAX_MESSAGES) throw new OaeError('message limit');
    const flag = final ? 1 : 0;
    const nonce = randomBytes(NONCE_BYTES);
    const sealed = gcm(this.key, nonce, aad(this.seq, flag)).encrypt(plaintext);
    this.seq += 1;
    if (final) this.closed = true;
    return concatBytes(new Uint8Array([flag]), nonce, sealed);
  }

  open(message: Uint8Array): { plaintext: Uint8Array; final: boolean } {
    if (this.closed) throw new OaeError('message after the final one');
    if (this.seq >= MAX_MESSAGES) throw new OaeError('message limit');
    if (message.length < OVERHEAD) throw new OaeError('malformed message');
    const flag = message[0];
    if (flag !== 0 && flag !== 1) throw new OaeError('malformed message');
    let plaintext: Uint8Array;
    try {
      plaintext = gcm(this.key, message.subarray(1, 1 + NONCE_BYTES), aad(this.seq, flag)).decrypt(message.subarray(1 + NONCE_BYTES));
    } catch {
      throw new OaeError('message didn’t authenticate');
    }
    this.seq += 1;
    if (flag === 1) this.closed = true;
    return { plaintext, final: flag === 1 };
  }

  get finished(): boolean {
    return this.closed;
  }
}

/** `raw` as an RFC 9651 byte sequence, `:base64:`. */
export function encodeOaeHeader(raw: Uint8Array): string {
  return `:${Buffer.from(raw).toString('base64')}:`;
}

/** The bytes of a `:base64:` header value, which must be a 32-byte salt. */
export function decodeOaeHeader(value: string | null): Uint8Array {
  if (typeof value !== 'string' || value.length < 2 || !value.startsWith(':') || !value.endsWith(':')) throw new OaeError('malformed OAE header');
  const b64 = value.slice(1, -1);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new OaeError('malformed OAE header');
  const raw = new Uint8Array(Buffer.from(b64, 'base64'));
  if (raw.length !== SALT_BYTES) throw new OaeError('malformed OAE header');
  return raw;
}

function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + message.length);
  new DataView(out.buffer).setUint32(0, message.length, false);
  out.set(message, 4);
  return out;
}

/**
 * Splits a byte stream into frames' messages, rejecting any frame over `maxFrame` bytes. Chunks are
 * kept as they arrive and each byte is copied once, into the message it belongs to, so one large
 * frame fed in small chunks costs time linear in its size.
 */
class FrameReader {
  private chunks: Uint8Array[] = [];
  /** The index of the first chunk not yet fully read. */
  private first = 0;
  /** How far into `chunks[first]` has been read. */
  private offset = 0;
  /** Unread bytes across all chunks. */
  private length = 0;
  constructor(private readonly maxFrame: number) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** The next whole frame's message, or null when more bytes are needed. */
  next(): Uint8Array | null {
    if (this.length < 4) return null;
    const size = new DataView(this.peek(4).buffer).getUint32(0, false);
    if (size > this.maxFrame) throw new OaeError('frame too large');
    if (this.length < 4 + size) return null;
    this.read(4, true);
    return this.read(size, true);
  }

  get empty(): boolean {
    return this.length === 0;
  }

  private peek(n: number): Uint8Array {
    return this.read(n, false);
  }

  /** Copies the next `n` unread bytes (n ≤ length), consuming them when `consume` is set. */
  private read(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let index = this.first;
    let offset = this.offset;
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[index];
      const take = Math.min(chunk.length - offset, n - filled);
      out.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (offset === chunk.length) {
        index += 1;
        offset = 0;
      }
    }
    if (consume) {
      this.first = index;
      this.offset = offset;
      this.length -= n;
      this.compact();
    }
    return out;
  }

  /** Drops read chunks once they are most of the list, so the list doesn't grow with the stream. */
  private compact(): void {
    if (this.first === this.chunks.length) {
      this.chunks = [];
      this.first = 0;
    } else if (this.first > 64 && this.first * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.first);
      this.first = 0;
    }
  }
}

function parseAppHeader(plaintext: Uint8Array): AppHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(plaintext));
  } catch {
    throw new OaeError('unreadable app header');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new OaeError('unreadable app header');
  return parsed as AppHeader;
}

/** The opener for a reply, from the reply's response salt. */
export class ResponseOpener {
  private readonly stream: Stream;
  private header: AppHeader | null = null;
  private readonly frames: FrameReader;

  constructor(key: Uint8Array, maxFrame: number) {
    this.stream = new Stream(key);
    this.frames = new FrameReader(maxFrame);
  }

  /**
   * Feeds bytes and returns the body plaintext of each message completed by them (empty messages
   * left out). The first message is taken as the app header. Throws `OaeError` on anything that
   * doesn't open in order, or bytes after the final message.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.stream.finished && chunk.length > 0) throw new OaeError('bytes after the final message');
    this.frames.push(chunk);
    const out: Uint8Array[] = [];
    for (let message = this.frames.next(); message !== null; message = this.frames.next()) {
      const opened = this.stream.open(message);
      if (this.header === null) {
        if (opened.final) throw new OaeError('no body after the app header');
        this.header = parseAppHeader(opened.plaintext);
      } else if (opened.plaintext.length > 0) {
        out.push(opened.plaintext);
      }
      if (opened.final && !this.frames.empty) throw new OaeError('bytes after the final message');
    }
    return out;
  }

  /** Called when the bytes end. Throws when the final message hasn't arrived or a frame is cut off. */
  finish(): void {
    if (!this.stream.finished || !this.frames.empty) throw new OaeError('truncated');
  }

  get appHeader(): AppHeader | null {
    return this.header;
  }
}

/** One request and its reply. Single use. */
export interface Exchange {
  /** The `Privatemode-OAE-Request-Header` value. */
  requestHeader: string;
  /** The sealed request body: the app header frame, then `body` in one final frame. */
  body: Uint8Array<ArrayBuffer>;
  /** An opener for the reply, from its `Privatemode-OAE-Response-Header` value. Throws `OaeError` on a bad header. */
  accept(responseHeader: string | null, maxFrame: number): ResponseOpener;
}

/** Seals `body` for `secret` (32 bytes) with `appHeader` as the first frame. */
export function sealRequest(secret: Uint8Array, body: Uint8Array, appHeader: AppHeader): Exchange {
  if (secret.length !== SECRET_BYTES) throw new OaeError('secret isn’t 32 bytes');
  const salt = randomBytes(SALT_BYTES);
  const prk = extract(sha256, secret, salt);
  const sealer = new Stream(expand(sha256, prk, REQUEST_INFO, 32));
  // concatBytes allocates a fresh ArrayBuffer, which fetch takes as a body.
  const sealed = concatBytes(frame(sealer.seal(utf8ToBytes(JSON.stringify(appHeader)), false)), frame(sealer.seal(body, true)));
  let accepted = false;
  return {
    requestHeader: encodeOaeHeader(salt),
    body: sealed as Uint8Array<ArrayBuffer>,
    accept(responseHeader, maxFrame) {
      if (accepted) throw new OaeError('reply already accepted');
      accepted = true;
      const responseSalt = decodeOaeHeader(responseHeader);
      return new ResponseOpener(expand(sha256, prk, concatBytes(RESPONSE_INFO_PREFIX, responseSalt), 32), maxFrame);
    },
  };
}

/** Opens a whole reply body: its app header and its body plaintext, joined. Throws `OaeError`. */
export function openWhole(opener: ResponseOpener, bytes: Uint8Array): { appHeader: AppHeader; body: Uint8Array } {
  const parts = opener.push(bytes);
  opener.finish();
  return { appHeader: opener.appHeader as AppHeader, body: concatBytes(...parts) };
}

/**
 * The plaintext of a streamed reply: each event's bytes as its frame opens. The stream errors on
 * a frame that doesn't open, bytes after the final frame, or a body that ends before it.
 * Cancelling it cancels `body`.
 */
export function openStream(opener: ResponseOpener, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          for (;;) {
            const read = await reader.read();
            if (read.done) {
              opener.finish();
              controller.close();
              return;
            }
            const parts = opener.push(read.value);
            for (const part of parts) controller.enqueue(part);
            if (parts.length > 0) return;
          }
        } catch (err) {
          void reader.cancel().catch((): undefined => undefined);
          throw err;
        }
      },
      cancel(reason): Promise<void> {
        return reader.cancel(reason).catch((): undefined => undefined);
      },
    },
    { highWaterMark: 0 }
  );
}
