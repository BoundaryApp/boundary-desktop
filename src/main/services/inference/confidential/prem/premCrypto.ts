/**
 * Prem's request sealing for `POST /rvenc/chat/completions`.
 *
 * The client encapsulates to the enclave's X-Wing public key and encrypts the request JSON with
 * XChaCha20-Poly1305 under the X-Wing shared secret directly (no KDF, no AAD), with a random
 * 24-byte nonce. A non-streamed reply is encrypted under the same secret, and under the request nonce
 * unless the reply names its own. A stream
 * `data` frame is either bare hex under the request nonce or JSON `{nonce, data}` with its own
 * nonce. Every byte field on the wire is hex. From Prem's docs; the spike's stub confirmed the
 * non-streamed reply. noble names X-Wing `ml_kem768_x25519`.
 *
 * The enclave key comes from Prem's key service and isn't covered by Prem's attestation
 * evidence (trust level C).
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_kem768_x25519 as XWing } from '@noble/post-quantum/hybrid.js';

export interface PremSealed {
  body: { encryptedInference: string; cipherText: string; nonce: string; model: string; stream: boolean };
  /** The X-Wing shared secret. Opens the reply; never leaves this process. */
  sharedSecret: Uint8Array;
  /** The request nonce, which a non-streamed reply and bare-hex stream frames reuse. */
  nonce: Uint8Array;
}

const NONCE_BYTES = 24;
const NONCE_HEX = /^[0-9a-fA-F]{48}$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const PUBLIC_KEY_HEX = new RegExp(`^[0-9a-fA-F]{${XWing.lengths.publicKey * 2}}$`);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Whether `value` is hex of an X-Wing public key's length. */
export function isPremPublicKey(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_KEY_HEX.test(value);
}

export function sealRequest(request: Record<string, unknown>, publicKeyHex: string): PremSealed {
  if (!isPremPublicKey(publicKeyHex)) {
    throw new Error('Prem’s enclave key isn’t an XWing public key');
  }
  if (typeof request.model !== 'string' || request.model === '') throw new Error('The request has no model');
  let encapsulated: { cipherText: Uint8Array; sharedSecret: Uint8Array };
  try {
    encapsulated = XWing.encapsulate(hexToBytes(publicKeyHex));
  } catch {
    throw new Error('Prem’s enclave key isn’t an XWing public key');
  }
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(encapsulated.sharedSecret, nonce).encrypt(utf8ToBytes(JSON.stringify(request)));
  return {
    body: {
      encryptedInference: bytesToHex(sealed),
      cipherText: bytesToHex(encapsulated.cipherText),
      nonce: bytesToHex(nonce),
      model: request.model,
      stream: request.stream === true,
    },
    sharedSecret: encapsulated.sharedSecret,
    nonce,
  };
}

/** Decrypts hex under the secret and nonce and parses the UTF-8 JSON, or returns `undefined`. */
function open(hex: unknown, sharedSecret: Uint8Array, nonce: Uint8Array): { value: unknown } | undefined {
  if (typeof hex !== 'string' || !HEX.test(hex)) return undefined;
  try {
    const plain = xchacha20poly1305(sharedSecret, nonce).decrypt(hexToBytes(hex));
    return { value: JSON.parse(utf8.decode(plain)) };
  } catch {
    return undefined;
  }
}

/**
 * Opens a non-streamed reply's `encryptedResponse`. Tries the reply's own `nonce` first when it is
 * 24-byte hex, then the request nonce, which Prem's docs say the reply reuses. Throws a fixed
 * error when neither decrypts.
 */
export function openResponse(encryptedHex: string, sharedSecret: Uint8Array, requestNonce: Uint8Array, replyNonce?: unknown): unknown {
  const named = typeof replyNonce === 'string' && NONCE_HEX.test(replyNonce) ? open(encryptedHex, sharedSecret, hexToBytes(replyNonce)) : undefined;
  const opened = named ?? open(encryptedHex, sharedSecret, requestNonce);
  if (!opened) throw new Error('Prem’s reply didn’t decrypt');
  return opened.value;
}

/**
 * Opens one stream `data` frame: bare hex under the request nonce, or JSON `{nonce, data}` with a
 * 24-byte hex nonce of its own. Anything else, including a frame that fails authentication,
 * throws a fixed error.
 */
export function openFrame(data: string, sharedSecret: Uint8Array, requestNonce: Uint8Array): unknown {
  let opened: { value: unknown } | undefined;
  if (typeof data === 'string' && HEX.test(data)) {
    opened = open(data, sharedSecret, requestNonce);
  } else {
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      frame = undefined;
    }
    if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
      const { nonce, data: inner } = frame as { nonce?: unknown; data?: unknown };
      if (typeof nonce === 'string' && NONCE_HEX.test(nonce)) opened = open(inner, sharedSecret, hexToBytes(nonce));
    }
  }
  if (!opened) throw new Error('Prem’s stream frame didn’t decrypt');
  return opened.value;
}
