import { describe, it, expect } from 'vitest';
import { buildRunpodDiagnostics } from '../infrastructure/runpodDiagnostics';

describe('buildRunpodDiagnostics', () => {
  it('flags throttling when throttled workers present', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerState: { initializing: 1, throttled: 2, unhealthy: 0 },
      workerCount: 2,
    });
    expect(diagnostics.some((d) => d.includes('throttled'))).toBe(true);
  });

  it('flags missing workers', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerCount: 0,
    });
    expect(diagnostics.some((d) => d.includes('No workers'))).toBe(true);
  });

  it('flags gpuCount below 2', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerCount: 1,
      gpuCount: 1,
    });
    expect(diagnostics.some((d) => d.includes('gpuCount'))).toBe(true);
  });
});
