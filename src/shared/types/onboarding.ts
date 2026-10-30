import type { SecretPreview } from './secrets';
import type { IpcResult } from '../ipc/result';

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
  /** Tried in order after the app default when it can't answer (ADR 0033). */
  appFallbacks?: import('./inferenceChain').InferenceChainEntry[];
  slots: Partial<Record<InferenceSlotId, LlmSlotStatus>>;
  pending?: PendingProviderSetup;
}

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

/** A provider setup an experiment started and has not finished; status reports it until a slot is configured. */
export interface PendingProviderSetup {
  providerId: string;
  providerName: string;
  instanceId: string;
  taskId: string;
  startedAt: string;
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

/** A change to the inference connections, with the status after it. */
export type InferenceStatusResult = IpcResult<{ status?: InferenceProvidersStatus }>;

export type SaveLlmConnectionResult = InferenceStatusResult;

export interface UpdateLlmModelInput {
  modelId: string;
  slot?: InferenceSlotId;
}

export type UpdateLlmModelResult = InferenceStatusResult;

export interface SendLlmTestMessageInput {
  message: string;
  slot?: InferenceSlotId;
}

export interface SetAppDefaultInput {
  slot: InferenceSlotId;
}

export type SetAppDefaultResult = InferenceStatusResult;

export interface SetAppFallbacksInput {
  fallbacks: import('./inferenceChain').InferenceChainEntry[];
}

export type SetAppFallbacksResult = InferenceStatusResult;

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

export type CancelOAuthPkceResult = IpcResult;

export type SaveOpenAiConfigResult = InferenceStatusResult;

export type ClearOpenAiConfigResult = InferenceStatusResult;

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

export type AdoptLocalLlmResult = InferenceStatusResult;

export interface LocalLlmChangedPayload {
  endpoints: DiscoveredLocalLlm[];
}
