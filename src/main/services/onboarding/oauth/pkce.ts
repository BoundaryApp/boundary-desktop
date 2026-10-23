import { randomBytes, createHash } from 'node:crypto';

const VERIFIER_LENGTH = 64;

function base64UrlEncode(buffer: Buffer): string {
  return buffer
   .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generateCodeVerifier(length = VERIFIER_LENGTH): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  let verifier = '';
  for (let i = 0; i < length; i += 1) {
    verifier += alphabet[bytes[i]! % alphabet.length];
  }
  return verifier;
}

export function computeS256Challenge(codeVerifier: string): string {
  const digest = createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(digest);
}
