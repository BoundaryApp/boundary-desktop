import type { ProviderId, StackVariableDef } from './infrastructure';
import type { SecretPreview } from './secrets';

export type ProviderSetupValue = string | number | boolean;

export type LlmConnectionKind = 'manual' | 'local-llm' | 'oauth' | 'infrastructure';
export type LlmModelChangePolicy = 'fixed' | 'selectable';
export type LlmEndpointChangePolicy = 'fixed' | 'editable';
export type OAuthConnectionProviderId = 'openrouter';

export interface LlmConnectionCapabilities {
  kind: LlmConnectionKind;
  modelChangePolicy: LlmModelChangePolicy;
  endpointChangePolicy: LlmEndpointChangePolicy;
  supportsModelRefresh: boolean;
}

export interface ListedModelPricing {
  /** USD per input token, as returned by the provider (decimal string). */
  promptPerToken?: string;
  /** USD per output token, as returned by the provider (decimal string). */
  completionPerToken?: string;
}

/** Artificial Analysis composite indexes (via OpenRouter benchmarks API). */
export interface ListedModelAaBenchmarks {
  intelligence?: number;
  coding?: number;
}

export interface ListedModel {
  id: string;
  displayName?: string;
  description?: string;
  contextLength?: number;
  pricing?: ListedModelPricing;
  aa?: ListedModelAaBenchmarks;
}

export type InferenceSlotId = 'local' | 'openrouter' | 'infrastructure';
export type LlmSlotHealth = 'unknown' | 'reachable' | 'unreachable' | 'unauthorized';

export interface LlmConnectionStatus {
  configured: boolean;
  endpointUrl?: string;
  modelId?: string;
  provider?: string;
  providerDisplayName?: string;
  authScheme?: 'bearer' | 'api-key';
  capabilities?: LlmConnectionCapabilities;
  apiKey?: SecretPreview;
  encryptionAvailable: boolean;
  pending?: PendingProviderSetup;
  health?: LlmSlotHealth;
  lastSeenAt?: string;
}

export interface LlmSlotStatus {
  configured: boolean;
  endpointUrl?: string;
  modelId?: string;
  provider?: string;
  providerDisplayName?: string;
  authScheme?: 'bearer' | 'api-key';
  capabilities?: LlmConnectionCapabilities;
  apiKey?: SecretPreview;
  health?: LlmSlotHealth;
  lastSeenAt?: string;
}

export interface InferenceProvidersStatus {
  configured: boolean;
  encryptionAvailable: boolean;
  appDefault: InferenceSlotId | null;
  slots: Partial<Record<InferenceSlotId, LlmSlotStatus>>;
  pending?: PendingProviderSetup;
}

/** @deprecated Use InferenceProvidersStatus */
export type OpenAiOnboardingStatus = InferenceProvidersStatus;

export function emptyInferenceProvidersStatus(
  encryptionAvailable = true
): InferenceProvidersStatus {
  return {
    configured: false,
    encryptionAvailable,
    appDefault: null,
    slots: {},
  };
}

export function defaultSlotStatus(
  status: InferenceProvidersStatus | null | undefined
): LlmSlotStatus | undefined {
  if (!status?.appDefault) return undefined;
  return status.slots[status.appDefault];
}

export interface PendingProviderSetup {
  providerId: OnboardingProviderId;
  providerName: string;
  instanceId: string;
  taskId: string;
  startedAt: string;
}

export interface SaveOpenAiConfigInput {
  endpointUrl: string;
  apiKey?: string;
  modelId?: string;
}

export interface SaveLlmConnectionInput {
  endpointUrl: string;
  apiKey?: string;
  modelId: string;
  provider: string;
  providerDisplayName?: string;
  authScheme?: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
  slot?: InferenceSlotId;
}

export interface SaveLlmConnectionResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface UpdateLlmModelInput {
  modelId: string;
  slot?: InferenceSlotId;
}

export interface UpdateLlmModelResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface SendLlmTestMessageInput {
  message: string;
  slot?: InferenceSlotId;
}

export interface SetAppDefaultInput {
  slot: InferenceSlotId;
}

export interface SetAppDefaultResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface ProbeSlotHealthInput {
  slot: InferenceSlotId;
}

export interface ProbeSlotHealthResult {
  success: boolean;
  health: LlmSlotHealth;
  status?: InferenceProvidersStatus;
  lastSeenAt?: string;
  error?: string;
}

export interface ClearLlmSlotInput {
  slot: InferenceSlotId;
}

export interface ListConfiguredEndpointModelsInput {
  slot?: InferenceSlotId;
}

export interface SendLlmTestMessageResult {
  success: boolean;
  content?: string;
  error?: string;
}

export interface ListEndpointModelsInput {
  baseUrl: string;
  apiKey?: string;
  authScheme?: 'bearer' | 'api-key';
  provider?: string;
  extraHeaders?: Record<string, string>;
}

export interface ListEndpointModelsResult {
  success: boolean;
  models: ListedModel[];
  error?: string;
}

export interface OAuthConnectionProviderSummary {
  id: OAuthConnectionProviderId;
  displayName: string;
  description: string;
}

export interface ListOAuthProvidersResult {
  success: boolean;
  providers: OAuthConnectionProviderSummary[];
  error?: string;
}

export interface StartOAuthPkceInput {
  providerId: OAuthConnectionProviderId;
}

export interface OAuthPkceCredentialsBundle {
  providerId: OAuthConnectionProviderId;
  providerDisplayName: string;
  endpointUrl: string;
  /** Present after a fresh PKCE exchange; omitted when resuming from a securely stored key. */
  apiKey?: string;
  authScheme: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}

export interface StartOAuthPkceResult {
  success: boolean;
  credentials?: OAuthPkceCredentialsBundle;
  error?: string;
}

export interface CancelOAuthPkceResult {
  success: boolean;
  error?: string;
}

export interface SaveOpenAiConfigResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface ClearOpenAiConfigResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export type OnboardingProviderId = 'baseten' | 'cerebrium' | 'modal' | 'beam';

export interface OnboardingProviderConfig {
  id: OnboardingProviderId;
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
  capability: string;
  infrastructureProvider?: ProviderId;
  modelId?: string;
  fields: StackVariableDef[];
  capabilities?: {
    authFieldName?: string;
    deploymentListing?: boolean;
    endpointAdoption?: boolean;
    deployableModels?: boolean;
    /**
     * Credential fields that must be collected before the model picker is shown
     * (e.g. Cerebrium token + project ID for plan-limit filtering).
     */
    accountCredentialFields?: string[];
  };
}

export interface StartProviderSetupInput {
  providerId: OnboardingProviderId;
  modelId?: string;
  values: Record<string, ProviderSetupValue>;
}

export interface StartProviderSetupResult {
  success: boolean;
  pending?: PendingProviderSetup;
  error?: string;
}

export interface DiscoverProviderEndpointsInput {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
}

export interface DiscoveredProviderEndpoint {
  providerId: OnboardingProviderId;
  providerName: string;
  modelId: string;
  deploymentId?: string;
  displayName: string;
  endpointUrl: string;
  healthStatus?: string;
  verified: boolean;
}

export interface DiscoverProviderEndpointsResult {
  success: boolean;
  endpoints: DiscoveredProviderEndpoint[];
  error?: string;
}

export interface ListProviderDeploymentsInput {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
}

export interface ListProviderDeploymentsResult {
  success: boolean;
  endpoints: DiscoveredProviderEndpoint[];
  error?: string;
}

export interface OnboardingDeployableModel {
  providerId: OnboardingProviderId;
  modelId: string;
  displayName: string;
  description?: string;
  gated: boolean;
  recipeId: string;
  requiredCredentials: StackVariableDef[];
  alreadyDeployed?: boolean;
  /** When false, the model should be shown but not deployable (e.g. plan limits). Default true. */
  deployable?: boolean;
  unavailableReason?: string;
  /** e.g. "2× HOPPER_H100, 16 CPU, 160 GB" */
  hardwareSummary?: string;
}

export interface ListDeployableModelsInput {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
}

export interface ListDeployableModelsResult {
  success: boolean;
  models: OnboardingDeployableModel[];
  error?: string;
}

export interface AdoptProviderEndpointInput {
  providerId: OnboardingProviderId;
  endpointUrl: string;
  apiKey: string;
  modelId?: string;
  deploymentId?: string;
}

export interface AdoptProviderEndpointResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface ProviderFormDraft {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
  selectedModelId?: string;
}

export interface GetProviderFormDraftInput {
  providerId: OnboardingProviderId;
}

export interface GetProviderFormDraftResult {
  success: boolean;
  draft?: ProviderFormDraft | null;
  error?: string;
}

export interface SaveProviderFormDraftInput {
  providerId: OnboardingProviderId;
  values: Record<string, ProviderSetupValue>;
  sensitiveNames: string[];
  selectedModelId?: string;
}

export interface SaveProviderFormDraftResult {
  success: boolean;
  error?: string;
}

export interface ClearProviderFormDraftInput {
  providerId?: OnboardingProviderId;
}

export interface ClearProviderFormDraftResult {
  success: boolean;
  error?: string;
}

export type LocalLlmRuntime = 'ollama' | 'lmstudio';

export interface DiscoveredLocalLlmModel {
  id: string;
  loaded: boolean;
}

export interface DiscoveredLocalLlm {
  runtime: LocalLlmRuntime;
  displayName: string;
  baseUrl: string;
  models: DiscoveredLocalLlmModel[];
}

export interface DiscoverLocalLlmsResult {
  success: boolean;
  endpoints: DiscoveredLocalLlm[];
  error?: string;
}

export interface AdoptLocalLlmInput {
  runtime: LocalLlmRuntime;
  endpointUrl: string;
  modelId?: string;
}

export interface AdoptLocalLlmResult {
  success: boolean;
  status?: InferenceProvidersStatus;
  error?: string;
}

export interface DismissLocalLlmInput {
  runtime: LocalLlmRuntime;
  endpointUrl: string;
}

export interface DismissLocalLlmResult {
  success: boolean;
  error?: string;
}

export interface LocalLlmChangedPayload {
  endpoints: DiscoveredLocalLlm[];
  toastCandidates: DiscoveredLocalLlm[];
}
