import { describe, it, expect } from 'vitest';
import { buildRunpodDiagnostics } from '../infrastructure/runpodDiagnostics';

describe('buildRunpodDiagnostics', () => {
  it('does not show no-workers when GraphQL state counts are non-zero', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerCount: 0,
      workerState: { initializing: 1, throttled: 0, idle: 0, running: 0, unhealthy: 0 },
    });
    expect(diagnostics.some((d) => d.includes('No workers allocated'))).toBe(false);
    expect(diagnostics.some((d) => d.includes('initializing'))).toBe(true);
  });

  it('uses scale-to-zero message when workersMin is 0 during warming', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerCount: 0,
      workersMin: 0,
      warmingSince: new Date().toISOString(),
    });
    expect(diagnostics.some((d) => d.includes('scale-to-zero'))).toBe(true);
    expect(diagnostics.some((d) => d.includes('No workers allocated yet'))).toBe(false);
  });

  it('softens health timeout message during warming', () => {
    const diagnostics = buildRunpodDiagnostics({
      workerCount: 0,
      warmingSince: new Date().toISOString(),
      healthMessage: 'The operation was aborted due to timeout',
    });
    expect(diagnostics.some((d) => d.includes('expected while'))).toBe(true);
  });
});
