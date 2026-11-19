#!/usr/bin/env node
/**
 * Records the public evidence nearAttestation.test.ts verifies offline: a NEAR AI Cloud
 * attestation report for one model, Intel's collateral for its first model quote, NVIDIA's
 * NRAS reply to its GPU evidence, and NVIDIA's signing keys. No API key is used; every
 * endpoint is public. Run it once with `bun run record:near-fixtures`
 * and commit the fixtures it writes.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCollateralFromPcs } from '@phala/dcap-qvl';

const MODEL = 'Qwen/Qwen3.8-27B';
const REPORT_URL = 'https://cloud-api.near.ai/v1/attestation/report';
const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'src/main/services/inference/confidential/near/__tests__/fixtures');

async function json(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

function write(name, value) {
  writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${name}`);
}

const nonce = randomBytes(32).toString('hex');
const query = new URLSearchParams({ model: MODEL, signing_algo: 'ed25519', nonce });
const report = await json(`${REPORT_URL}?${query}`);
const attestation = report.model_attestations?.[0];
if (!attestation) throw new Error('The report has no model attestation');

const collateral = await getCollateralFromPcs(Buffer.from(attestation.intel_quote, 'hex'));
const nras = await json(NRAS_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: attestation.nvidia_payload,
});
const jwks = await json(JWKS_URL);
const recordedAt = new Date();

mkdirSync(out, { recursive: true });
write('recording.json', {
  model: MODEL,
  nonce,
  recordedAt: recordedAt.toISOString(),
  recordedAtSecs: Math.floor(recordedAt.getTime() / 1000),
});
write('report.json', report);
write('intel-collateral.json', collateral);
write('nras-reply.json', nras);
write('nvidia-jwks.json', jwks);
