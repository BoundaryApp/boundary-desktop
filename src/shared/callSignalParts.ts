/**
 * Call setup messages over peer signals (ADR 0044 §1). A session description with video can
 * pass a signal's 4 KB, so a message is compressed and, if still too large, split into numbered
 * parts the receiver puts back together. Runs in the renderer and in tests.
 */

/** Base64 characters per part, which keeps each part's JSON well under the signal limit. */
export const CALL_PART_CHARS = 3_000;
/** A message in more parts than this is refused, so a peer can't make a receiver hold a lot. */
export const MAX_CALL_PARTS = 12;
/** Parts of a message that hasn't finished within this long are dropped. */
export const CALL_PART_TTL_MS = 20_000;

export interface CallPart {
  t: 'part';
  /** The message's id, 16 hex characters, chosen by the sender. */
  id: string;
  n: number;
  of: number;
  /** A piece of the deflated message, in base64. */
  z: string;
}

const MESSAGE_ID = /^[0-9a-f]{16}$/;

export function isCallPart(value: unknown): value is CallPart {
  const part = value as Partial<CallPart> | null;
  return (
    typeof part === 'object' &&
    part !== null &&
    part.t === 'part' &&
    typeof part.id === 'string' &&
    MESSAGE_ID.test(part.id) &&
    Number.isInteger(part.of) &&
    part.of! >= 1 &&
    part.of! <= MAX_CALL_PARTS &&
    Number.isInteger(part.n) &&
    part.n! >= 0 &&
    part.n! < part.of! &&
    typeof part.z === 'string' &&
    part.z.length > 0 &&
    part.z.length <= CALL_PART_CHARS
  );
}

async function streamBytes(input: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([input as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface PackedCallMessage {
  parts: CallPart[];
  /** The message's JSON before compression. */
  rawBytes: number;
  /** The compressed message in base64, as it goes over the wire across all parts. */
  sentChars: number;
}

/** Compress `message` and split it into parts. Throws when it needs more than the parts allowed. */
export async function packCallMessage(message: unknown): Promise<PackedCallMessage> {
  const raw = new TextEncoder().encode(JSON.stringify(message));
  const z = toBase64(await streamBytes(raw, new CompressionStream('deflate-raw')));
  const of = Math.max(1, Math.ceil(z.length / CALL_PART_CHARS));
  if (of > MAX_CALL_PARTS) throw new Error('That call message is too large to send.');
  const id = randomId();
  const parts = Array.from({ length: of }, (_, n) => ({
    t: 'part' as const,
    id,
    n,
    of,
    z: z.slice(n * CALL_PART_CHARS, (n + 1) * CALL_PART_CHARS),
  }));
  return { parts, rawBytes: raw.length, sentChars: z.length };
}

interface Pending {
  of: number;
  pieces: (string | undefined)[];
  started: number;
}

/**
 * Puts parts back together per sender. Repeats are ignored, order doesn't matter, a part that
 * disagrees with the others about the count drops the message, and unfinished messages expire.
 */
export class CallPartAssembler {
  private pending = new Map<string, Pending>();

  /** The finished message when `part` completes one, else null. */
  async add(from: string, part: CallPart, now = Date.now()): Promise<unknown> {
    this.expire(now);
    const key = `${from}/${part.id}`;
    let entry = this.pending.get(key);
    if (entry && entry.of !== part.of) {
      this.pending.delete(key);
      return null;
    }
    if (!entry) {
      entry = { of: part.of, pieces: Array.from({ length: part.of }, (): string | undefined => undefined), started: now };
      this.pending.set(key, entry);
    }
    entry.pieces[part.n] = part.z;
    if (entry.pieces.some((piece) => piece === undefined)) return null;
    this.pending.delete(key);
    try {
      const bytes = await streamBytes(fromBase64(entry.pieces.join('')), new DecompressionStream('deflate-raw'));
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return null;
    }
  }

  /** Messages still waiting for parts. */
  get waiting(): number {
    return this.pending.size;
  }

  private expire(now: number): void {
    for (const [key, entry] of this.pending) {
      if (now - entry.started > CALL_PART_TTL_MS) this.pending.delete(key);
    }
  }
}
