/**
 * Cerebrium plan hardware limits used for pre-deploy gating.
 *
 * Subscription API returns planCode but not explicit maxCpu/maxMemory fields.
 * Limits are seeded from Cerebrium pricing docs and observed API errors
 * (e.g. Hobby-style accounts rejecting cpu > 16).
 */

export interface CerebriumPlanLimits {
  planCode: string;
  maxCpu: number;
  maxMemoryGb: number;
  maxGpuCount: number;
  allowedCompute: string[];
}

export interface CerebriumHardwareConfig {
  compute: string;
  cpu: number;
  memory: number;
  gpuCount: number;
}

export type CerebriumPlanEvaluation =
  | { ok: true }
  | { ok: false; reason: string };

const HOBBY_COMPUTE = [
  'ADA_L40',
  'ADA_L4',
  'AMPERE_A10',
  'TURING_T4',
  'CPU',
] as const;

const STANDARD_COMPUTE = [
  ...HOBBY_COMPUTE,
  'AMPERE_A100',
  'AMPERE_A100_40GB',
  'AMPERE_A100_80GB',
] as const;

const ENTERPRISE_COMPUTE = [
  ...STANDARD_COMPUTE,
  'HOPPER_H100',
  'HOPPER_H200',
  'BLACKWELL_B200',
  'BLACKWELL_B300',
  'BLACKWELL_RTX6000',
] as const;

/** Conservative Hobby-like defaults for unknown plan codes. */
export const DEFAULT_CEREBRIUM_PLAN_LIMITS: CerebriumPlanLimits = {
  planCode: 'hobby',
  maxCpu: 16,
  maxMemoryGb: 192,
  maxGpuCount: 2,
  allowedCompute: [...HOBBY_COMPUTE],
};

const PLAN_LIMITS_BY_CODE: Record<string, CerebriumPlanLimits> = {
  free: {
    planCode: 'free',
    maxCpu: 16,
    maxMemoryGb: 192,
    maxGpuCount: 1,
    allowedCompute: [...HOBBY_COMPUTE],
  },
  hobby: {
    planCode: 'hobby',
    maxCpu: 16,
    maxMemoryGb: 192,
    maxGpuCount: 2,
    allowedCompute: [...HOBBY_COMPUTE],
  },
  standard: {
    planCode: 'standard',
    maxCpu: 24,
    maxMemoryGb: 256,
    maxGpuCount: 2,
    allowedCompute: [...STANDARD_COMPUTE],
  },
  enterprise: {
    planCode: 'enterprise',
    maxCpu: 48,
    maxMemoryGb: 512,
    maxGpuCount: 8,
    allowedCompute: [...ENTERPRISE_COMPUTE],
  },
};

function normalizePlanCode(planCode: string | undefined | null): string {
  return (planCode ?? '').trim().toLowerCase();
}

/**
 * Resolve plan limits from a Cerebrium planCode.
 * Unknown codes fall back to Hobby-like defaults.
 */
export function resolveCerebriumPlanLimits(planCode: string | undefined | null): CerebriumPlanLimits {
  const normalized = normalizePlanCode(planCode);
  if (!normalized) {
    return { ...DEFAULT_CEREBRIUM_PLAN_LIMITS };
  }

  const exact = PLAN_LIMITS_BY_CODE[normalized];
  if (exact) return { ...exact, allowedCompute: [...exact.allowedCompute] };

  // Fuzzy match e.g. "hobby_monthly", "Standard Plan"
  for (const [code, limits] of Object.entries(PLAN_LIMITS_BY_CODE)) {
    if (normalized.includes(code)) {
      return { ...limits, planCode: normalized, allowedCompute: [...limits.allowedCompute] };
    }
  }

  console.warn(
    `[cerebriumPlanLimits] Unknown planCode "${planCode}"; using Hobby-like defaults (maxCpu=${DEFAULT_CEREBRIUM_PLAN_LIMITS.maxCpu})`
  );
  return {
    ...DEFAULT_CEREBRIUM_PLAN_LIMITS,
    planCode: normalized,
    allowedCompute: [...DEFAULT_CEREBRIUM_PLAN_LIMITS.allowedCompute],
  };
}

/**
 * Prefer richer limit fields from a live subscription payload when present;
 * otherwise fall back to the local planCode table.
 */
export function resolveCerebriumPlanLimitsFromSubscription(subscription: {
  planCode?: string;
  maxCpu?: number;
  maxMemory?: number;
  maxMemoryGb?: number;
  maxGpuCount?: number;
  allowedCompute?: string[];
}): CerebriumPlanLimits {
  const base = resolveCerebriumPlanLimits(subscription.planCode);
  const maxCpu =
    typeof subscription.maxCpu === 'number' && Number.isFinite(subscription.maxCpu)
      ? subscription.maxCpu
      : base.maxCpu;
  const maxMemoryGb =
    typeof subscription.maxMemoryGb === 'number' && Number.isFinite(subscription.maxMemoryGb)
      ? subscription.maxMemoryGb
      : typeof subscription.maxMemory === 'number' && Number.isFinite(subscription.maxMemory)
        ? subscription.maxMemory
        : base.maxMemoryGb;
  const maxGpuCount =
    typeof subscription.maxGpuCount === 'number' && Number.isFinite(subscription.maxGpuCount)
      ? subscription.maxGpuCount
      : base.maxGpuCount;
  const allowedCompute =
    Array.isArray(subscription.allowedCompute) && subscription.allowedCompute.length > 0
      ? subscription.allowedCompute.filter((c): c is string => typeof c === 'string' && Boolean(c.trim()))
      : base.allowedCompute;

  return {
    planCode: base.planCode,
    maxCpu,
    maxMemoryGb,
    maxGpuCount,
    allowedCompute,
  };
}

export function formatCerebriumHardwareSummary(hardware: CerebriumHardwareConfig): string {
  const gpuLabel =
    hardware.gpuCount > 1
      ? `${hardware.gpuCount}× ${hardware.compute}`
      : hardware.compute;
  return `${gpuLabel}, ${hardware.cpu} CPU, ${hardware.memory} GB`;
}

export function evaluateCerebriumRecipeAgainstPlan(
  hardware: CerebriumHardwareConfig,
  limits: CerebriumPlanLimits
): CerebriumPlanEvaluation {
  if (hardware.cpu > limits.maxCpu) {
    return {
      ok: false,
      reason: `Requires ${hardware.cpu} CPUs; your plan allows ${limits.maxCpu}`,
    };
  }
  if (hardware.memory > limits.maxMemoryGb) {
    return {
      ok: false,
      reason: `Requires ${hardware.memory} GB memory; your plan allows ${limits.maxMemoryGb} GB`,
    };
  }
  if (hardware.gpuCount > limits.maxGpuCount) {
    return {
      ok: false,
      reason: `Requires ${hardware.gpuCount} GPUs; your plan allows ${limits.maxGpuCount}`,
    };
  }
  const compute = hardware.compute.trim();
  if (compute && !limits.allowedCompute.includes(compute)) {
    return {
      ok: false,
      reason: `Requires ${compute}; not available on your ${limits.planCode} plan`,
    };
  }
  return { ok: true };
}

export function hardwareFromDriverConfig(config: Record<string, unknown>): CerebriumHardwareConfig {
  const compute =
    typeof config.compute === 'string' && config.compute.trim()
      ? config.compute.trim()
      : 'HOPPER_H100';
  const cpu = typeof config.cpu === 'number' && Number.isFinite(config.cpu) ? config.cpu : 8;
  const memory =
    typeof config.memory === 'number' && Number.isFinite(config.memory) ? config.memory : 64;
  const gpuCount =
    typeof config.gpu_count === 'number' && Number.isFinite(config.gpu_count)
      ? config.gpu_count
      : 1;
  return { compute, cpu, memory, gpuCount };
}
