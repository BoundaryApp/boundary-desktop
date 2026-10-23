import { z } from 'zod';
import type { SecretPreview } from './secrets';

export const StackPhaseSchema = z.enum([
  'unprovisioned',
  'configuring',
  'ready',
  'planning',
  'applying',
  'warming',
  'active',
  'degraded',
  'destroying',
  'destroyed',
  'error',
]);
export type StackPhase = z.infer<typeof StackPhaseSchema>;

export const StackVariableTypeSchema = z.enum(['string', 'number', 'boolean', 'enum']);
export type StackVariableType = z.infer<typeof StackVariableTypeSchema>;

export const StackVariableDefSchema = z.object({
  name: z.string().min(1),
  type: StackVariableTypeSchema,
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().default(false),
  sensitive: z.boolean().default(false),
  group: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type StackVariableDef = z.infer<typeof StackVariableDefSchema>;
export type StackSecretPreviews = Record<string, SecretPreview>;

export const StackManifestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  modulePath: z.string().min(1),
  profilePath: z.string().optional(),
  terraformMinVersion: z.string().default('1.5.0'),
  variables: z.array(StackVariableDefSchema),
});
export type StackManifest = z.infer<typeof StackManifestSchema>;

export const StackProfileSchema = z.object({
  id: z.string().min(1),
  dockerImage: z.string().min(1),
  template: z.object({
    containerDiskInGb: z.number().default(50),
    volumeInGb: z.number().default(80),
    category: z.enum(['NVIDIA', 'AMD', 'CPU']).default('NVIDIA'),
  }),
  templateEnv: z.record(z.string(), z.string()),
  terraform: z.object({
    endpoint_name: z.string(),
    data_center_ids: z.string(),
    gpu_type_ids: z.string(),
    gpu_count: z.number().default(2),
    workers_max: z.number(),
    idle_timeout: z.number(),
    flashboot: z.boolean(),
  }),
});
export type StackProfile = z.infer<typeof StackProfileSchema>;

export const ProviderIdSchema = z.enum(['runpod', 'baseten', 'modal', 'cerebrium']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const DriverKindSchema = z.enum([
  'terraform',
  'baseten-truss',
  'modal-app',
  'cerebrium-api',
]);
export type DriverKind = z.infer<typeof DriverKindSchema>;

export const ModelDeploymentOptionSchema = z.object({
  provider: ProviderIdSchema,
  recipeId: z.string().min(1),
  available: z.boolean(),
});
export type ModelDeploymentOption = z.infer<typeof ModelDeploymentOptionSchema>;

export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  gated: z.boolean().default(false),
  deployments: z.array(ModelDeploymentOptionSchema),
});
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const ModelCatalogSchema = z.object({
  models: z.array(ModelCatalogEntrySchema),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const RecipeDriverSchema = z.object({
  kind: DriverKindSchema,
  artifactPath: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const RecipeReadinessSchema = z.object({
  probe: z.enum(['openai-models']).default('openai-models'),
  warmupPost: z.boolean().default(false),
  verifyChatCompletion: z.boolean().default(false),
  warmingTimeoutMs: z.number().positive(),
  pollIntervalMs: z.object({
    warming: z.number().positive(),
    active: z.number().positive(),
    degraded: z.number().positive(),
  }),
});

export const RecipeOutputsSchema = z.object({
  authSecret: z.string().min(1),
  openaiBaseUrlKey: z.string().min(1).default('openai_base_url'),
});

export const DeploymentRecipeSchema = z.object({
  id: z.string().min(1),
  modelId: z.string().min(1),
  provider: ProviderIdSchema,
  displayName: z.string().min(1),
  description: z.string().optional(),
  driver: RecipeDriverSchema,
  secrets: z.array(StackVariableDefSchema),
  readiness: RecipeReadinessSchema,
  outputs: RecipeOutputsSchema,
  legacyStackTypeId: z.string().optional(),
  terraformMinVersion: z.string().optional(),
  modulePath: z.string().optional(),
  profilePath: z.string().optional(),
});
export type DeploymentRecipe = z.infer<typeof DeploymentRecipeSchema>;

export interface ProviderRuntimeSnapshot {
  provider: ProviderId;
  message?: string;
  consoleUrl?: string;
}

export interface CreateDeploymentInput {
  modelId: string;
  provider: ProviderId;
  displayName?: string;
}

export interface TrussCheckResult {
  ok: boolean;
  version?: string;
  command?: string;
  error?: string;
  /** Truss runs from Boundary's managed install under app userData. */
  managed?: boolean;
  /** Not installed yet; Boundary will install on deploy. */
  pendingInstall?: boolean;
}

export interface InfrastructurePrerequisites {
  provider: ProviderId;
  ok: boolean;
  error?: string;
  requiresTerraform: boolean;
  requiresTruss?: boolean;
  terraform?: TerraformCheckResult;
  truss?: TrussCheckResult;
}

export type StackHealthStatus =
  | 'unknown'
  | 'healthy'
  | 'unhealthy'
  | 'idle'
  | 'blocked'
  | 'skipped';

/** Baseten workspace billing settings (payment method, credits). */
export const BASETEN_BILLING_URL = 'https://app.baseten.co/settings/billing';

export interface RunpodWorkerStateCounts {
  initializing: number;
  throttled: number;
  idle: number;
  running: number;
  unhealthy: number;
}

export interface RunpodWorkerSummary {
  id: string;
  desiredStatus?: string;
  lastStatusChange?: string;
  gpuCount?: number;
  dataCenterId?: string;
}

export interface RunpodRuntimeSnapshot {
  endpointId?: string;
  gpuCount?: number;
  workerState?: RunpodWorkerStateCounts;
  workers?: RunpodWorkerSummary[];
  modelStatus?: string;
  warmingSince?: string;
  diagnostics?: string[];
  logsAvailable: boolean;
  logTail?: string[];
  logMessage?: string;
  consoleUrl?: string;
}

export interface InfrastructureStackInstance {
  id: string;
  stackTypeId: string;
  displayName: string;
  phase: StackPhase;
  vars: Record<string, string | number | boolean>;
  outputs: Record<string, string>;
  lastTaskId?: string;
  driftDetected: boolean;
  healthStatus: StackHealthStatus;
  healthMessage?: string;
  modelId?: string;
  provider?: ProviderId;
  recipeId?: string;
  externalIds?: Record<string, string>;
  /** ISO timestamp when the stack entered warming (model cold start). */
  warmingSince?: string;
  /** Last background POST /chat/completions used to wake scale-to-zero workers. */
  lastWarmupProbeAt?: string;
  /** Warmup POSTs sent this warming cycle (capped to avoid flooding RunPod's queue). */
  warmupProbeCount?: number;
  /** ISO timestamp when a real chat completion returned a non-empty response. */
  endpointVerifiedAt?: string;
  /** Last background chat completion verification attempt. */
  lastEndpointVerificationAt?: string;
  workspacePath?: string;
  /** RunPod serverless template id created/managed by Boundary. */
  runpodTemplateId?: string;
  templateManagedByBoundary?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StackOperationStatus {
  taskId?: string;
  taskStatus?: string;
  currentStage?: string;
  progress?: number;
}

export interface StackStatusSnapshot {
  instanceId: string;
  stackTypeId: string;
  displayName: string;
  phase: StackPhase;
  modelId?: string;
  provider?: ProviderId;
  operation?: StackOperationStatus;
  driftDetected: boolean;
  resourceCount?: number;
  outputs: Record<string, string>;
  healthStatus: StackHealthStatus;
  healthMessage?: string;
  runpodRuntime?: RunpodRuntimeSnapshot;
  providerRuntime?: ProviderRuntimeSnapshot;
  requiresTerraform?: boolean;
  requiresTruss?: boolean;
  terraformAvailable: boolean;
  terraformVersion?: string;
  trussAvailable: boolean;
  trussPendingInstall?: boolean;
  trussVersion?: string;
  trussCommand?: string;
  lastChecked: string;
}

export interface TerraformCheckResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export type StackChatRole = 'user' | 'assistant' | 'system';

export interface StackChatMessage {
  role: StackChatRole;
  content: string;
}

export interface StackChatStartPayload {
  instanceId: string;
  messages: StackChatMessage[];
  requestId?: string;
}

export interface StackChatStartResult {
  success: boolean;
  requestId?: string;
  error?: string;
}

export interface StackChatChunkEvent {
  requestId: string;
  delta: string;
}

export interface StackChatEndEvent {
  requestId: string;
  finishReason?: string;
}

export interface StackChatErrorEvent {
  requestId: string;
  error: string;
}

export interface StackChatCancelPayload {
  requestId: string;
}
