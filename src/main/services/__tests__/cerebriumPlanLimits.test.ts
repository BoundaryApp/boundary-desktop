import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CEREBRIUM_PLAN_LIMITS,
  evaluateCerebriumRecipeAgainstPlan,
  formatCerebriumHardwareSummary,
  hardwareFromDriverConfig,
  resolveCerebriumPlanLimits,
  resolveCerebriumPlanLimitsFromSubscription,
} from '../infrastructure/cerebriumPlanLimits';

describe('cerebriumPlanLimits', () => {
  it('resolves known plan codes', () => {
    expect(resolveCerebriumPlanLimits('hobby').maxCpu).toBe(16);
    expect(resolveCerebriumPlanLimits('standard').maxCpu).toBe(24);
    expect(resolveCerebriumPlanLimits('enterprise').allowedCompute).toContain('HOPPER_H100');
  });

  it('falls back to Hobby-like defaults for unknown plan codes', () => {
    const limits = resolveCerebriumPlanLimits('custom-unknown-plan');
    expect(limits.maxCpu).toBe(DEFAULT_CEREBRIUM_PLAN_LIMITS.maxCpu);
    expect(limits.planCode).toBe('custom-unknown-plan');
  });

  it('prefers richer subscription fields when present', () => {
    const limits = resolveCerebriumPlanLimitsFromSubscription({
      planCode: 'hobby',
      maxCpu: 12,
      maxMemoryGb: 128,
      maxGpuCount: 1,
      allowedCompute: ['ADA_L40'],
    });
    expect(limits.maxCpu).toBe(12);
    expect(limits.maxMemoryGb).toBe(128);
    expect(limits.maxGpuCount).toBe(1);
    expect(limits.allowedCompute).toEqual(['ADA_L40']);
  });

  it('rejects recipes that exceed CPU plan limit', () => {
    const result = evaluateCerebriumRecipeAgainstPlan(
      { compute: 'ADA_L40', cpu: 32, memory: 64, gpuCount: 1 },
      resolveCerebriumPlanLimits('hobby')
    );
    expect(result).toEqual({
      ok: false,
      reason: 'Requires 32 CPUs; your plan allows 16',
    });
  });

  it('rejects disallowed GPU SKUs', () => {
    const result = evaluateCerebriumRecipeAgainstPlan(
      { compute: 'HOPPER_H100', cpu: 8, memory: 64, gpuCount: 1 },
      resolveCerebriumPlanLimits('hobby')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('HOPPER_H100');
    }
  });

  it('accepts recipes within plan limits', () => {
    const result = evaluateCerebriumRecipeAgainstPlan(
      { compute: 'ADA_L40', cpu: 6, memory: 64, gpuCount: 1 },
      resolveCerebriumPlanLimits('hobby')
    );
    expect(result).toEqual({ ok: true });
  });

  it('formats hardware summary and parses driver config', () => {
    const hardware = hardwareFromDriverConfig({
      compute: 'HOPPER_H100',
      cpu: 16,
      memory: 160,
      gpu_count: 2,
    });
    expect(hardware).toEqual({
      compute: 'HOPPER_H100',
      cpu: 16,
      memory: 160,
      gpuCount: 2,
    });
    expect(formatCerebriumHardwareSummary(hardware)).toBe('2× HOPPER_H100, 16 CPU, 160 GB');
  });
});
