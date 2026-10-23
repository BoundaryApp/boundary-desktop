export type CapabilityCheckId = 'runtime' | 'compose' | 'memory' | 'cpu' | 'disk';

export type CapabilityCheckResult = {
  id: CapabilityCheckId;
  label: string;
  passed: boolean;
  required: string;
  actual: string;
  detail?: string;
};

export type CapabilityAssessment = {
  passed: boolean;
  /** True when core assistant compose containers are already running. */
  stackAlreadyRunning: boolean;
  checkedAt: string;
  checks: CapabilityCheckResult[];
};

export type CapabilityStatus = {
  acknowledged: boolean;
  lastAssessment: CapabilityAssessment | null;
  /** Latest bundled-runtime provision message, if any. */
  provisionProgress?: string | null;
  /** Absolute path of the packaged-debug JSONL log. */
  debugLogPath?: string | null;
};

export type AcknowledgeCapabilityResult = {
  success: boolean;
  status: CapabilityStatus;
  error?: string;
};
