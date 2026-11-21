import type { IpcResult } from '../ipc/result';

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

/**
 * Where resolving the container runtime has got to, in order: look for system Docker, then
 * for the bundled Podman machine configure, create (first run only), start and connect.
 * `ready` means a runtime answered, whichever one it was.
 */
export type RuntimeProvisionStage = 'docker' | 'configure' | 'create' | 'start' | 'connect' | 'ready';

export type RuntimeProvisionSnapshot = {
  stage: RuntimeProvisionStage;
  /** Every stage this resolve has entered, in order, including `stage`. */
  reached: RuntimeProvisionStage[];
  /** Epoch ms `stage` began. */
  stageStartedAt: number;
};

export type CapabilityStatus = {
  acknowledged: boolean;
  lastAssessment: CapabilityAssessment | null;
  /** Latest bundled-runtime provision message, if any. */
  provisionProgress?: string | null;
  /** The runtime resolve's stage, if one has run since launch. */
  provisionStage?: RuntimeProvisionSnapshot | null;
  /** Absolute path of the packaged-debug JSONL log. */
  debugLogPath?: string | null;
};

export type AcknowledgeCapabilityResult = IpcResult<{
  status: CapabilityStatus;
}>;
