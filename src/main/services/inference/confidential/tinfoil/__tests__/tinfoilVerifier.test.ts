import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fromHex, Verifier } from '@tinfoilsh/verifier';
import { describe, expect, it } from 'vitest';

const fixtures = path.join(__dirname, 'fixtures');

describe('recorded Tinfoil router document', () => {
  // Ruling 3 of the phase 7 plan: the verifier is checked against real evidence before any adapter code.
  it('verifies offline at its recording time', async () => {
    const doc = new Uint8Array(readFileSync(path.join(fixtures, 'router-attestation-v3.json')));
    const nonce = fromHex(readFileSync(path.join(fixtures, 'router-attestation-nonce.txt'), 'utf8').trim());
    const when = new Date(readFileSync(path.join(fixtures, 'recorded-at.txt'), 'utf8').trim());
    const verifier = await Verifier.create();
    const v = await verifier.verifyV3At(doc, nonce, 'tinfoilsh/confidential-model-router', when);
    expect(v.tlsPublicKeyFP).toBe('e5db636af31d94d74871ab63d5e62ac2d34beab02032629dac2685149b7d99d7');
    expect(v.codeTag).toBe('v0.0.176');
    expect(v.freshnessExpiresAt?.toISOString()).toBe('2026-11-19T22:58:15.000Z');
  });
});
