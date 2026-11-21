import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { expect } from 'vitest';

/**
 * A stand-in for Privatemode's proxy, written with node:crypto from the construction in
 * edgelesssys/privatemode-public `internal/oss/oae` (MIT): HKDF by hand with HMAC-SHA256, and
 * AES-256-GCM through node:crypto rather than @noble, so a shared mistake can't pass both sides.
 */

export const SECRET = Buffer.alloc(32, 7);

function hkdfExtract(ikm: Buffer, salt: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

/** HKDF-Expand for one 32-byte block: T(1) = HMAC(PRK, info || 0x01). */
function hkdfExpand32(prk: Buffer, info: Buffer): Buffer {
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
}

function aadFor(seq: number, flag: number): Buffer {
  const out = Buffer.alloc(5);
  out.writeUInt32BE(seq, 0);
  out[4] = flag;
  return out;
}

function sealMessage(key: Buffer, seq: number, plaintext: Buffer, final: boolean): Buffer {
  const flag = final ? 1 : 0;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadFor(seq, flag));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([flag]), nonce, ct, cipher.getAuthTag()]);
}

function openMessage(key: Buffer, seq: number, message: Buffer): { plaintext: Buffer; final: boolean } {
  const flag = message[0];
  const nonce = message.subarray(1, 13);
  const tag = message.subarray(message.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aadFor(seq, flag));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(message.subarray(13, message.length - 16)), decipher.final()]);
  return { plaintext, final: flag === 1 };
}

function frame(message: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(message.length, 0);
  return Buffer.concat([len, message]);
}

export function frames(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let at = 0;
  while (at < bytes.length) {
    const size = bytes.readUInt32BE(at);
    out.push(bytes.subarray(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return out;
}

/** The responder: opens the request and seals replies, as Privatemode's proxy would. */
export function responder(requestHeader: string, secret: Buffer = SECRET) {
  const requestSalt = Buffer.from(requestHeader.slice(1, -1), 'base64');
  const prk = hkdfExtract(secret, requestSalt);
  const requestKey = hkdfExpand32(prk, Buffer.from('privatemode oae request key\0'));
  const responseSalt = randomBytes(32);
  const responseKey = hkdfExpand32(prk, Buffer.concat([Buffer.from('privatemode oae response key\0'), responseSalt]));
  let seq = 0;
  const seal = (plaintext: Buffer | string, final: boolean): Buffer => frame(sealMessage(responseKey, seq++, Buffer.from(plaintext), final));
  return {
    responseHeader: `:${responseSalt.toString('base64')}:`,
    openRequest(body: Uint8Array): { header: unknown; body: string } {
      const opened = frames(Buffer.from(body)).map((m, i) => openMessage(requestKey, i, m));
      expect(opened.map((o) => o.final)).toEqual([false, true]);
      return { header: JSON.parse(opened[0].plaintext.toString('utf8')), body: opened[1].plaintext.toString('utf8') };
    },
    seal,
    unary(contentType: string, body: string): Buffer {
      return Buffer.concat([seal(JSON.stringify({ content_type: contentType }), false), seal(body, true)]);
    },
  };
}
