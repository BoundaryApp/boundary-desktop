import type {
  DeploymentRecipe,
  DriverKind,
  ProviderRuntimeSnapshot,
} from '../../../../shared/types/infrastructure';

export interface DriverContext {
  instanceId: string;
  recipe: DeploymentRecipe;
  taskId: string;
  workspacePath?: string;
  log: (stage: string, message?: string) => Promise<void>;
}

export interface DriverProvisionResult {
  success: boolean;
  outputs?: Record<string, string>;
  externalIds?: Record<string, string>;
  error?: string;
}

export interface DriverDestroyResult {
  success: boolean;
  error?: string;
}

export interface InferenceProviderDriver {
  kind: DriverKind;
  requiresTerraform: boolean;
  /** Allocate per-instance workspace (Truss project, etc.). */
  requiresWorkspace?: boolean;
  /** Requires Truss CLI (system or Boundary-managed install). */
  requiresTruss?: boolean;
  validateSecrets(instanceId: string, recipe: DeploymentRecipe): Promise<string | null>;
  provision(ctx: DriverContext): Promise<DriverProvisionResult>;
  destroy(ctx: DriverContext): Promise<DriverDestroyResult>;
  getRuntime?(
    instanceId: string,
    recipe: DeploymentRecipe
  ): Promise<ProviderRuntimeSnapshot | RunpodRuntimeReexport | null>;
}

/** Re-export RunPod snapshot shape for driver return type union. */
import type { RunpodRuntimeSnapshot } from '../../../../shared/types/infrastructure';
export type RunpodRuntimeReexport = RunpodRuntimeSnapshot;
