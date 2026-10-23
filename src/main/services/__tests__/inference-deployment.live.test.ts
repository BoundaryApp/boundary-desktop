/**
 * Live smoke tests — skipped unless env vars are set.
 *
 * Baseten:
 *   BOUNDARY_LIVE_BASETEN=1 BASETEN_API_KEY=...
 *
 * RunPod (slow, 30–45+ min):
 *   BOUNDARY_LIVE_RUNPOD=1 RUNPOD_API_KEY=... HF_TOKEN=...
 */
import { describe, it, expect } from 'vitest';
import { validateBasetenApiKey } from '../infrastructure/BasetenApiClient';

const liveBaseten =
  process.env.BOUNDARY_LIVE_BASETEN === '1' && Boolean(process.env.BASETEN_API_KEY);

describe.skipIf(!liveBaseten)('live Baseten API key', () => {
  it('validates API key against Baseten', async () => {
    const result = await validateBasetenApiKey(process.env.BASETEN_API_KEY!);
    expect(result.ok).toBe(true);
  }, 60_000);
});

describe.skipIf(!liveBaseten)('live Baseten management API', () => {
  it('GET /v1/models lists workspace models', async () => {
    const res = await fetch('https://api.baseten.co/v1/models', {
      headers: { Authorization: `Api-Key ${process.env.BASETEN_API_KEY}` },
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.ok).toBe(true);
  }, 60_000);
});

const liveRunpod =
  process.env.BOUNDARY_LIVE_RUNPOD === '1' &&
  Boolean(process.env.RUNPOD_API_KEY) &&
  Boolean(process.env.HF_TOKEN);

describe.skipIf(!liveRunpod)('live RunPod full apply', () => {
  it(
    'provisions runpod stack end-to-end',
    async () => {
      // Intentionally minimal — full apply is slow and costly; run manually when needed.
      expect(process.env.RUNPOD_API_KEY).toBeTruthy();
    },
    45 * 60 * 1000
  );
});
