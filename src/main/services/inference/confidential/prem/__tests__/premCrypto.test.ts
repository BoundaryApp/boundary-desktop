import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { ml_kem768_x25519 as XWing } from '@noble/post-quantum/hybrid.js';
import { describe, expect, it } from 'vitest';
import { openFrame, openResponse, sealRequest } from '../premCrypto';

const utf8 = new TextDecoder();

function sealed(sharedSecret: Uint8Array, nonce: Uint8Array, value: unknown): string {
  return bytesToHex(xchacha20poly1305(sharedSecret, nonce).encrypt(utf8ToBytes(JSON.stringify(value))));
}

describe('sealRequest', () => {
  it('seals a request a holder of the XWing secret can open', () => {
    const { publicKey, secretKey } = XWing.keygen();
    const request = { model: 'qwen38-27b', stream: true, messages: [{ role: 'user', content: 'hi' }] };

    const out = sealRequest(request, bytesToHex(publicKey));

    expect(out.body.model).toBe('qwen38-27b');
    expect(out.body.stream).toBe(true);
    for (const field of [out.body.encryptedInference, out.body.cipherText, out.body.nonce]) {
      expect(field).toMatch(/^[0-9a-f]+$/);
    }
    expect(out.nonce).toHaveLength(24);
    expect(out.body.nonce).toBe(bytesToHex(out.nonce));

    const secret = XWing.decapsulate(hexToBytes(out.body.cipherText), secretKey);
    expect(bytesToHex(secret)).toBe(bytesToHex(out.sharedSecret));
    const plain = xchacha20poly1305(secret, hexToBytes(out.body.nonce)).decrypt(hexToBytes(out.body.encryptedInference));
    expect(JSON.parse(utf8.decode(plain))).toEqual(request);
  });

  it('defaults stream to false', () => {
    const { publicKey } = XWing.keygen();
    expect(sealRequest({ model: 'm' }, bytesToHex(publicKey)).body.stream).toBe(false);
  });

  it('refuses a public key that isn’t XWing-sized hex', () => {
    const { publicKey } = XWing.keygen();
    expect(() => sealRequest({ model: 'm' }, 'zz')).toThrow('Prem’s enclave key isn’t an XWing public key');
    expect(() => sealRequest({ model: 'm' }, bytesToHex(publicKey.subarray(1)))).toThrow(
      'Prem’s enclave key isn’t an XWing public key',
    );
  });

  it('refuses a request without a model', () => {
    const { publicKey } = XWing.keygen();
    expect(() => sealRequest({}, bytesToHex(publicKey))).toThrow('The request has no model');
  });
});

describe('openResponse', () => {
  it('opens a non-streamed reply under the request nonce', () => {
    const secret = randomBytes(32);
    const nonce = randomBytes(24);
    const reply = { choices: [{ message: { role: 'assistant', content: 'hello' } }] };
    expect(openResponse(sealed(secret, nonce, reply), secret, nonce)).toEqual(reply);
  });

  it('opens a reply under its own nonce when it names a valid one', () => {
    const secret = randomBytes(32);
    const requestNonce = randomBytes(24);
    const replyNonce = randomBytes(24);
    const reply = { choices: [] as unknown[] };
    expect(openResponse(sealed(secret, replyNonce, reply), secret, requestNonce, bytesToHex(replyNonce))).toEqual(reply);
    expect(() => openResponse(sealed(secret, replyNonce, reply), secret, requestNonce)).toThrow('Prem’s reply didn’t decrypt');
  });

  it('falls back to the request nonce when the reply’s nonce is missing, malformed or not the one it’s sealed under', () => {
    const secret = randomBytes(32);
    const nonce = randomBytes(24);
    const reply = { choices: [] as unknown[] };
    for (const replyNonce of [undefined, null, 'abcd', 42, `${bytesToHex(randomBytes(24))}00`, bytesToHex(randomBytes(24))]) {
      expect(openResponse(sealed(secret, nonce, reply), secret, nonce, replyNonce)).toEqual(reply);
    }
  });

  it('throws a fixed error when the reply doesn’t authenticate', () => {
    const secret = randomBytes(32);
    const nonce = randomBytes(24);
    const hex = sealed(secret, nonce, { secret: 'never shown' });
    const error = (() => {
      try {
        openResponse(hex, randomBytes(32), nonce);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toBe('Prem’s reply didn’t decrypt');
  });

  it('throws when the reply isn’t hex or the plaintext isn’t JSON', () => {
    const secret = randomBytes(32);
    const nonce = randomBytes(24);
    expect(() => openResponse('not hex', secret, nonce)).toThrow('Prem’s reply didn’t decrypt');
    const notJson = bytesToHex(xchacha20poly1305(secret, nonce).encrypt(utf8ToBytes('plain text')));
    expect(() => openResponse(notJson, secret, nonce)).toThrow('Prem’s reply didn’t decrypt');
  });
});

describe('openFrame', () => {
  it('opens both frame shapes', () => {
    const secret = randomBytes(32);
    const requestNonce = randomBytes(24);
    const chunk = { choices: [{ delta: { content: 'a' } }] };
    expect(openFrame(sealed(secret, requestNonce, chunk), secret, requestNonce)).toEqual(chunk);

    const frameNonce = randomBytes(24);
    const framed = JSON.stringify({ nonce: bytesToHex(frameNonce), data: sealed(secret, frameNonce, chunk) });
    expect(openFrame(framed, secret, requestNonce)).toEqual(chunk);
  });

  it('throws on a frame that is neither', () => {
    const secret = randomBytes(32);
    const nonce = randomBytes(24);
    const fixed = 'Prem’s stream frame didn’t decrypt';
    expect(() => openFrame('{"choices":[]}', secret, nonce)).toThrow(fixed);
    expect(() => openFrame('', secret, nonce)).toThrow(fixed);
    expect(() => openFrame('hello', secret, nonce)).toThrow(fixed);
    expect(() => openFrame(JSON.stringify({ nonce: 'abcd', data: sealed(secret, nonce, {}) }), secret, nonce)).toThrow(
      fixed,
    );
    expect(() => openFrame(JSON.stringify({ nonce: bytesToHex(nonce), data: 5 }), secret, nonce)).toThrow(fixed);
    // Hex under a different nonce fails authentication.
    expect(() => openFrame(sealed(secret, randomBytes(24), {}), secret, nonce)).toThrow(fixed);
  });
});
