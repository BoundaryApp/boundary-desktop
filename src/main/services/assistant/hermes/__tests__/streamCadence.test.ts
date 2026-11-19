import { describe, expect, it } from 'vitest';
import { createStreamCadence, STALL_GAP_MS } from '../streamCadence';

describe('createStreamCadence', () => {
  it('has no summary before any chunk', () => {
    expect(createStreamCadence().summary()).toBeNull();
  });

  it('ignores empty chunks', () => {
    const cadence = createStreamCadence();
    cadence.add(0, 1000);
    expect(cadence.summary()).toBeNull();
  });

  it('reports a single chunk with no gaps or rate', () => {
    const cadence = createStreamCadence();
    cadence.add(12, 1000);
    expect(cadence.summary()).toEqual({
      chunks: 1,
      chars: 12,
      spanMs: 0,
      charsPerSec: null,
      chunkCharsP50: 12,
      chunkCharsMax: 12,
      gapMsP50: null,
      gapMsP90: null,
      gapMsMax: null,
      stalls: 0,
    });
  });

  it('summarises sizes, gaps, rate and stalls', () => {
    const cadence = createStreamCadence();
    // Gaps: 20, 20, 20, 300 (one stall). Sizes: 4, 4, 8, 4, 20.
    cadence.add(4, 0);
    cadence.add(4, 20);
    cadence.add(8, 40);
    cadence.add(4, 60);
    cadence.add(20, 60 + STALL_GAP_MS + 50);
    expect(cadence.summary()).toEqual({
      chunks: 5,
      chars: 40,
      spanMs: 360,
      charsPerSec: 111.1,
      chunkCharsP50: 4,
      chunkCharsMax: 20,
      gapMsP50: 20,
      gapMsP90: 300,
      gapMsMax: 300,
      stalls: 1,
    });
  });

  it('treats a clock step backwards as a zero gap', () => {
    const cadence = createStreamCadence();
    cadence.add(4, 100);
    cadence.add(4, 90);
    expect(cadence.summary()?.gapMsMax).toBe(0);
  });
});
