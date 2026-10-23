import { safeStorage } from 'electron';
import Store from 'electron-store';
import {
  INFRASTRUCTURE_LLM_CAPABILITIES,
  LOCAL_LLM_CAPABILITIES,
  MANUAL_LLM_CAPABILITIES,
} from '../../../shared/llmConnectionDefaults';
import type {
  InferenceProvidersStatus,
  InferenceSlotId,
  LlmConnectionCapabilities,
  LlmSlotHealth,
  LlmSlotStatus,
  LocalLlmRuntime,
  OnboardingProviderId,
  PendingProviderSetup,
  SaveLlmConnectionInput,
  SaveLlmConnectionResult,
  SaveOpenAiConfigInput,
  SaveOpenAiConfigResult,
  ClearOpenAiConfigResult,
  SetAppDefaultResult,
  UpdateLlmModelResult,
} from '../../../shared/types/onboarding';
import { secretPreview } from '../secrets/secretPreview';
import { dummyApiKeyForLocalLlm } from './LocalLlmDiscovery';
import { clearProviderFormDraft } from './ProviderFormDraftStore';

export const INFERENCE_SCHEMA_VERSION = 2;

export interface StoredConnection {
  endpointUrl: string;
  encryptedApiKey: string;
  modelId?: string;
  provider?: string;
  providerDisplayName?: string;
  authScheme?: 'bearer' | 'api-key';
  capabilities?: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
  lastSeenAt?: string;
}

interface InferenceSlots {
  local?: StoredConnection;
  openrouter?: StoredConnection;
  infrastructure?: StoredConnection;
}

interface OpenAiOnboardingStoreShape {
  schemaVersion?: number;
  slots?: InferenceSlots;
  appDefault?: InferenceSlotId | null;
  pendingProviderSetup?: PendingProviderSetup;
  endpointUrl?: string;
  encryptedApiKey?: string;
  modelId?: string;
  provider?: string;
  providerDisplayName?: string;
  authScheme?: 'bearer' | 'api-key';
  capabilities?: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}

const store = new Store<OpenAiOnboardingStoreShape>({
  name: 'openai-onboarding',
  defaults: {
    schemaVersion: undefined,
    slots: {},
    appDefault: null,
    endpointUrl: '',
    encryptedApiKey: '',
    provider: '',
    authScheme: 'bearer',
  },
});

const ephemeralHealth = new Map<InferenceSlotId, LlmSlotHealth>();

function normalizeEndpointUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Enter a valid OpenAI-compatible endpoint URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Endpoint URL must start with http:// or https://.');
  }

  return parsed.toString().replace(/\/$/, '');
}

function requireApiKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Enter an API key.');
  }
  return trimmed;
}

function requireModelId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error('Select a model.');
  }
  return trimmed;
}

function deleteStoreKey(key: keyof OpenAiOnboardingStoreShape): void {
  const maybeDelete = (store as Store<OpenAiOnboardingStoreShape> & {
    delete?: (key: keyof OpenAiOnboardingStoreShape) => void;
  }).delete;
  if (typeof maybeDelete === 'function') {
    maybeDelete.call(store, key);
    return;
  }
  store.set(key, undefined as never);
}

export function isOpenAiConfigEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function isLoopbackHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

function hostContainsOpenRouter(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.includes('openrouter.ai');
  } catch {
    return url.includes('openrouter.ai');
  }
}

export function classifyInferenceSlot(input: {
  provider?: string;
  capabilities?: LlmConnectionCapabilities;
  endpointUrl?: string;
}): InferenceSlotId {
  const provider = input.provider ?? '';
  const kind = input.capabilities?.kind;
  if (provider === 'openrouter' || kind === 'oauth' || hostContainsOpenRouter(input.endpointUrl)) {
    return 'openrouter';
  }
  if (
    provider === 'ollama' ||
    provider === 'lmstudio' ||
    provider === 'local-manual' ||
    kind === 'local-llm' ||
    isLoopbackHost(input.endpointUrl)
  ) {
    return 'local';
  }
  return 'infrastructure';
}

function readSlots(): InferenceSlots {
  return { ...(store.get('slots') ?? {}) };
}

function writeSlots(slots: InferenceSlots): void {
  store.set('slots', slots);
}

function writeSlot(slot: InferenceSlotId, connection: StoredConnection): void {
  const slots = readSlots();
  slots[slot] = connection;
  writeSlots(slots);
}

function removeSlot(slot: InferenceSlotId): void {
  const slots = readSlots();
  delete slots[slot];
  writeSlots(slots);
  ephemeralHealth.delete(slot);
}

export function getAppDefaultSlot(): InferenceSlotId | null {
  ensureV2Document();
  return store.get('appDefault') ?? null;
}

function setStoredAppDefault(slot: InferenceSlotId | null): void {
  store.set('appDefault', slot);
}

function decryptApiKey(encrypted: string | undefined): string | null {
  if (!encrypted || !isOpenAiConfigEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
}

function v1ConnectionFromRoot(): StoredConnection | null {
  const endpointUrl = store.get('endpointUrl') ?? '';
  const encryptedApiKey = store.get('encryptedApiKey') ?? '';
  if (!endpointUrl || !encryptedApiKey) return null;
  return {
    endpointUrl,
    encryptedApiKey,
    modelId: store.get('modelId'),
    provider: store.get('provider') || undefined,
    providerDisplayName: store.get('providerDisplayName'),
    authScheme: store.get('authScheme') ?? 'bearer',
    capabilities: store.get('capabilities'),
    extraHeaders: store.get('extraHeaders'),
  };
}

function clearV1RootKeys(): void {
  deleteStoreKey('endpointUrl');
  deleteStoreKey('encryptedApiKey');
  deleteStoreKey('modelId');
  deleteStoreKey('provider');
  deleteStoreKey('providerDisplayName');
  deleteStoreKey('capabilities');
  deleteStoreKey('extraHeaders');
  deleteStoreKey('authScheme');
}

export function ensureV2Document(): void {
  if (store.get('schemaVersion') === INFERENCE_SCHEMA_VERSION) {
    return;
  }

  const existingSlots = store.get('slots');
  const v1 = v1ConnectionFromRoot();
  if (v1 && (!existingSlots || Object.keys(existingSlots).length === 0)) {
    const slot = classifyInferenceSlot(v1);
    writeSlots({ [slot]: v1 });
    setStoredAppDefault(slot);
  } else if (!existingSlots) {
    writeSlots({});
    if (store.get('appDefault') === undefined) {
      setStoredAppDefault(null);
    }
  } else if (store.get('appDefault') === undefined) {
    setStoredAppDefault(null);
  }

  store.set('schemaVersion', INFERENCE_SCHEMA_VERSION);
  clearV1RootKeys();
}

function slotHasMaterial(connection: StoredConnection | undefined): boolean {
  if (!connection?.endpointUrl || !connection.encryptedApiKey) return false;
  return Boolean(decryptApiKey(connection.encryptedApiKey));
}

function slotIsConfigured(connection: StoredConnection | undefined): boolean {
  return Boolean(
    slotHasMaterial(connection) &&
      connection?.modelId?.trim() &&
      isOpenAiConfigEncryptionAvailable()
  );
}

function buildSlotStatus(connection: StoredConnection | undefined, slot: InferenceSlotId): LlmSlotStatus | undefined {
  if (!connection?.endpointUrl && !connection?.encryptedApiKey) {
    return undefined;
  }
  const apiKey = decryptApiKey(connection.encryptedApiKey);
  return {
    configured: slotIsConfigured(connection),
    endpointUrl: connection.endpointUrl || undefined,
    modelId: connection.modelId?.trim() || undefined,
    provider: connection.provider || undefined,
    providerDisplayName: connection.providerDisplayName,
    authScheme: connection.authScheme,
    capabilities: connection.capabilities,
    apiKey: secretPreview(apiKey),
    health: ephemeralHealth.get(slot),
    lastSeenAt: connection.lastSeenAt,
  };
}

export function buildInferenceProvidersStatus(): InferenceProvidersStatus {
  ensureV2Document();
  const slots = readSlots();
  const appDefault = store.get('appDefault') ?? null;
  const encryptionAvailable = isOpenAiConfigEncryptionAvailable();
  const defaultConnection = appDefault ? slots[appDefault] : undefined;
  const status: InferenceProvidersStatus = {
    configured: slotIsConfigured(defaultConnection),
    encryptionAvailable,
    appDefault,
    slots: {},
  };

  for (const slot of ['local', 'openrouter', 'infrastructure'] as const) {
    const slotStatus = buildSlotStatus(slots[slot], slot);
    if (slotStatus) {
      status.slots[slot] = slotStatus;
    }
  }

  const pending = store.get('pendingProviderSetup');
  if (pending && !status.configured) {
    status.pending = pending;
  }
  return status;
}

export function getOpenAiOnboardingStatus(): InferenceProvidersStatus {
  return buildInferenceProvidersStatus();
}

export function getOpenAiApiKeyPreview() {
  return secretPreview(getOpenAiApiKey());
}

export function getOpenAiApiKey(): string | null {
  return getSlotApiKey(getAppDefaultSlot());
}

export function getSlotApiKey(slot: InferenceSlotId | null): string | null {
  ensureV2Document();
  if (!slot) return null;
  return decryptApiKey(readSlots()[slot]?.encryptedApiKey);
}

export interface LlmConnection {
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  authScheme: 'bearer' | 'api-key';
  provider?: string;
  providerDisplayName?: string;
  capabilities?: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}

function materialFromStored(
  connection: StoredConnection | undefined
): (Omit<LlmConnection, 'modelId'> & { modelId?: string }) | null {
  if (!connection) return null;
  const apiKey = decryptApiKey(connection.encryptedApiKey);
  if (!connection.endpointUrl || !apiKey || !isOpenAiConfigEncryptionAvailable()) {
    return null;
  }
  return {
    endpointUrl: connection.endpointUrl,
    apiKey,
    modelId: connection.modelId?.trim() || undefined,
    authScheme: connection.authScheme ?? 'bearer',
    provider: connection.provider || undefined,
    providerDisplayName: connection.providerDisplayName || undefined,
    capabilities: connection.capabilities,
    extraHeaders: connection.extraHeaders,
  };
}

export function getSlotConnectionMaterial(
  slot: InferenceSlotId
): (Omit<LlmConnection, 'modelId'> & { modelId?: string }) | null {
  ensureV2Document();
  return materialFromStored(readSlots()[slot]);
}

/** Stored endpoint + key material for the app-default slot, even when model selection is still pending. */
export function getStoredLlmConnectionMaterial(): Omit<LlmConnection, 'modelId'> & {
  modelId?: string;
} | null {
  const slot = getAppDefaultSlot();
  if (!slot) return null;
  return getSlotConnectionMaterial(slot);
}

export function getSlotLlmConnection(slot: InferenceSlotId): LlmConnection | null {
  const material = getSlotConnectionMaterial(slot);
  if (!material?.modelId) return null;
  return {
    endpointUrl: material.endpointUrl,
    apiKey: material.apiKey,
    modelId: material.modelId,
    authScheme: material.authScheme,
    provider: material.provider,
    providerDisplayName: material.providerDisplayName,
    capabilities: material.capabilities,
    extraHeaders: material.extraHeaders,
  };
}

export function getLlmConnection(): LlmConnection | null {
  const slot = getAppDefaultSlot();
  if (!slot) return null;
  return getSlotLlmConnection(slot);
}

export function getLocalSlotEndpointUrl(): string | undefined {
  ensureV2Document();
  return readSlots().local?.endpointUrl;
}

function assignAppDefaultIfEmpty(slot: InferenceSlotId): void {
  if (!getAppDefaultSlot()) {
    setStoredAppDefault(slot);
  }
}

function persistSlotConnection(
  slot: InferenceSlotId,
  input: {
    endpointUrl: string;
    encryptedApiKey: string;
    modelId?: string;
    provider: string;
    providerDisplayName?: string;
    authScheme: 'bearer' | 'api-key';
    capabilities: LlmConnectionCapabilities;
    extraHeaders?: Record<string, string>;
    lastSeenAt?: string;
  }
): void {
  ensureV2Document();
  const existing = readSlots()[slot];
  const connection: StoredConnection = {
    endpointUrl: input.endpointUrl,
    encryptedApiKey: input.encryptedApiKey,
    provider: input.provider,
    providerDisplayName: input.providerDisplayName ?? '',
    authScheme: input.authScheme,
    capabilities: input.capabilities,
  };
  if (input.modelId) {
    connection.modelId = input.modelId;
  }
  if (input.extraHeaders) {
    connection.extraHeaders = input.extraHeaders;
  }
  if (input.lastSeenAt ?? existing?.lastSeenAt) {
    connection.lastSeenAt = input.lastSeenAt ?? existing?.lastSeenAt;
  }
  writeSlot(slot, connection);
  assignAppDefaultIfEmpty(slot);
  deleteStoreKey('pendingProviderSetup');
  clearProviderFormDraft();
}

/**
 * Persist an OAuth-minted API key immediately after PKCE succeeds.
 * Model selection can happen later without forcing the user to sign in again.
 */
export function saveOAuthCredentials(input: {
  providerId: string;
  providerDisplayName: string;
  endpointUrl: string;
  apiKey: string;
  authScheme: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}): SaveLlmConnectionResult {
  if (!isOpenAiConfigEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: buildInferenceProvidersStatus(),
    };
  }

  try {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const apiKey = requireApiKey(input.apiKey);
    const encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');

    persistSlotConnection('openrouter', {
      endpointUrl,
      encryptedApiKey,
      provider: input.providerId,
      providerDisplayName: input.providerDisplayName,
      authScheme: input.authScheme,
      capabilities: input.capabilities,
      extraHeaders: input.extraHeaders,
    });

    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function hasPendingOAuthModelSelection(): boolean {
  const material = getSlotConnectionMaterial('openrouter');
  return Boolean(
    material &&
      !material.modelId &&
      material.capabilities?.kind === 'oauth' &&
      material.endpointUrl &&
      material.provider
  );
}

export function saveLlmConnection(input: SaveLlmConnectionInput): SaveLlmConnectionResult {
  if (!isOpenAiConfigEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: buildInferenceProvidersStatus(),
    };
  }

  try {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const slot =
      input.slot ??
      classifyInferenceSlot({
        provider: input.provider,
        capabilities: input.capabilities,
        endpointUrl,
      });
    const modelId = requireModelId(input.modelId);
    const apiKey = input.apiKey?.trim() ? requireApiKey(input.apiKey) : null;
    const encryptedApiKey = apiKey
      ? safeStorage.encryptString(apiKey).toString('base64')
      : readSlots()[slot]?.encryptedApiKey ?? '';
    if (!encryptedApiKey) {
      throw new Error('Enter an API key.');
    }

    persistSlotConnection(slot, {
      endpointUrl,
      encryptedApiKey,
      modelId,
      provider: input.provider,
      providerDisplayName: input.providerDisplayName,
      authScheme: input.authScheme ?? 'bearer',
      capabilities: input.capabilities,
      extraHeaders: input.extraHeaders,
    });

    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function updateLlmModel(modelId: string, slot?: InferenceSlotId): UpdateLlmModelResult {
  ensureV2Document();
  const target = slot ?? getAppDefaultSlot();
  if (!target) {
    return {
      success: false,
      error: 'No LLM connection is configured.',
      status: buildInferenceProvidersStatus(),
    };
  }

  const connection = readSlots()[target];
  if (!connection || connection.capabilities?.modelChangePolicy !== 'selectable') {
    return {
      success: false,
      error: 'Model changes are not allowed for this connection.',
      status: buildInferenceProvidersStatus(),
    };
  }

  try {
    const normalizedModelId = requireModelId(modelId);
    writeSlot(target, { ...connection, modelId: normalizedModelId });
    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function saveOpenAiConfig(input: SaveOpenAiConfigInput): SaveOpenAiConfigResult {
  if (!input.modelId) {
    return {
      success: false,
      error: 'Select a model.',
      status: buildInferenceProvidersStatus(),
    };
  }

  const endpointUrl = input.endpointUrl;
  const slot = classifyInferenceSlot({
    provider: isLoopbackHost(endpointUrl) ? 'local-manual' : 'manual',
    endpointUrl,
  });

  return saveLlmConnection({
    endpointUrl: input.endpointUrl,
    apiKey: input.apiKey,
    modelId: input.modelId,
    provider: slot === 'local' ? 'local-manual' : 'manual',
    providerDisplayName: slot === 'local' ? 'Local server' : 'Custom endpoint',
    authScheme: 'bearer',
    capabilities: MANUAL_LLM_CAPABILITIES,
    slot,
  });
}

export function setPendingProviderSetup(pending: PendingProviderSetup): InferenceProvidersStatus {
  ensureV2Document();
  store.set('pendingProviderSetup', pending);
  return buildInferenceProvidersStatus();
}

export function clearPendingProviderSetup(): InferenceProvidersStatus {
  ensureV2Document();
  deleteStoreKey('pendingProviderSetup');
  return buildInferenceProvidersStatus();
}

export function saveLocalLlmEndpoint(input: {
  runtime: LocalLlmRuntime;
  endpointUrl: string;
  modelId: string;
}): SaveOpenAiConfigResult {
  if (!isOpenAiConfigEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: buildInferenceProvidersStatus(),
    };
  }

  try {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const modelId = requireModelId(input.modelId);
    const apiKey = dummyApiKeyForLocalLlm(input.runtime);
    const encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    const displayName = input.runtime === 'ollama' ? 'Ollama' : 'LM Studio';

    persistSlotConnection('local', {
      endpointUrl,
      encryptedApiKey,
      modelId,
      provider: input.runtime,
      providerDisplayName: displayName,
      authScheme: 'bearer',
      capabilities: LOCAL_LLM_CAPABILITIES,
    });

    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function saveProviderEndpoint(input: {
  providerId: OnboardingProviderId;
  instanceId: string;
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  authScheme?: 'bearer' | 'api-key';
  providerDisplayName?: string;
}): SaveOpenAiConfigResult {
  if (!isOpenAiConfigEncryptionAvailable()) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: buildInferenceProvidersStatus(),
    };
  }

  try {
    const pending = store.get('pendingProviderSetup');
    if (pending && pending.instanceId !== input.instanceId) {
      return {
        success: false,
        error: 'A different provider setup is currently pending.',
        status: buildInferenceProvidersStatus(),
      };
    }

    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const modelId = requireModelId(input.modelId);
    const apiKey = requireApiKey(input.apiKey);
    const encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');

    persistSlotConnection('infrastructure', {
      endpointUrl,
      encryptedApiKey,
      modelId,
      provider: input.providerId,
      providerDisplayName: input.providerDisplayName ?? input.providerId,
      authScheme: input.authScheme ?? 'bearer',
      capabilities: INFRASTRUCTURE_LLM_CAPABILITIES,
    });
    clearProviderFormDraft(input.providerId);

    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function finalizePendingProviderEndpoint(input: {
  instanceId: string;
  endpointUrl: string;
  apiKey: string;
  modelId: string;
  authScheme?: 'bearer' | 'api-key';
  providerDisplayName?: string;
}): SaveOpenAiConfigResult | null {
  const pending = store.get('pendingProviderSetup');
  if (!pending || pending.instanceId !== input.instanceId) {
    return null;
  }

  return saveProviderEndpoint({
    providerId: pending.providerId,
    instanceId: input.instanceId,
    endpointUrl: input.endpointUrl,
    apiKey: input.apiKey,
    modelId: input.modelId,
    authScheme: input.authScheme,
    providerDisplayName: input.providerDisplayName ?? pending.providerName,
  });
}

function nextDefaultAfterClear(cleared: InferenceSlotId): InferenceSlotId | null {
  const slots = readSlots();
  for (const slot of ['local', 'openrouter'] as const) {
    if (slot !== cleared && slotIsConfigured(slots[slot])) {
      return slot;
    }
  }
  if (cleared !== 'infrastructure' && slotIsConfigured(slots.infrastructure)) {
    return 'infrastructure';
  }
  return null;
}

export function clearLlmSlot(slot: InferenceSlotId): ClearOpenAiConfigResult {
  ensureV2Document();
  try {
    const wasDefault = getAppDefaultSlot() === slot;
    removeSlot(slot);
    if (wasDefault) {
      setStoredAppDefault(nextDefaultAfterClear(slot));
    }
    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function clearOpenAiConfig(): ClearOpenAiConfigResult {
  ensureV2Document();
  try {
    writeSlots({});
    setStoredAppDefault(null);
    deleteStoreKey('pendingProviderSetup');
    ephemeralHealth.clear();
    return {
      success: true,
      status: buildInferenceProvidersStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: buildInferenceProvidersStatus(),
    };
  }
}

export function setAppDefault(slot: InferenceSlotId): SetAppDefaultResult {
  ensureV2Document();
  const connection = readSlots()[slot];
  if (!slotIsConfigured(connection)) {
    return {
      success: false,
      error: 'Connect that provider before making it the app default.',
      status: buildInferenceProvidersStatus(),
    };
  }
  setStoredAppDefault(slot);
  return {
    success: true,
    status: buildInferenceProvidersStatus(),
  };
}

export function setSlotHealth(slot: InferenceSlotId, health: LlmSlotHealth): void {
  ephemeralHealth.set(slot, health);
}

export function getSlotHealth(slot: InferenceSlotId): LlmSlotHealth | undefined {
  return ephemeralHealth.get(slot);
}

export function markSlotLastSeen(slot: InferenceSlotId, at: string = new Date().toISOString()): void {
  ensureV2Document();
  const connection = readSlots()[slot];
  if (!connection) return;
  writeSlot(slot, { ...connection, lastSeenAt: at });
}

export function writeV1DocumentForTesting(input: StoredConnection): void {
  store.set('schemaVersion', undefined as never);
  store.set('slots', undefined as never);
  store.set('appDefault', undefined as never);
  store.set('endpointUrl', input.endpointUrl);
  store.set('encryptedApiKey', input.encryptedApiKey);
  if (input.modelId) store.set('modelId', input.modelId);
  if (input.provider) store.set('provider', input.provider);
  if (input.providerDisplayName) store.set('providerDisplayName', input.providerDisplayName);
  store.set('authScheme', input.authScheme ?? 'bearer');
  if (input.capabilities) store.set('capabilities', input.capabilities);
  if (input.extraHeaders) store.set('extraHeaders', input.extraHeaders);
}

export const __testing = {
  normalizeEndpointUrl,
  classifyInferenceSlot,
  ensureV2Document,
  writeV1DocumentForTesting,
};
