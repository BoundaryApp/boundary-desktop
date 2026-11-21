import Store from 'electron-store';
import { LOCAL_LLM_CAPABILITIES } from '../../../shared/llmConnectionDefaults';
import type {
  InferenceProvidersStatus,
  InferenceStatusResult,
  InferenceSlotId,
  LlmConnectionCapabilities,
  LlmSlotHealth,
  LlmSlotStatus,
  LocalLlmRuntime,
  PendingProviderSetup,
  SaveLlmConnectionInput,
  SaveLlmConnectionResult,
  SaveOpenAiConfigResult,
  ClearOpenAiConfigResult,
  UpdateLlmModelResult,
} from '../../../shared/types/onboarding';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type { ChainSlots } from '../inference/appInferenceChoice';
import { encryptToBase64, isOsEncryptionAvailable, tryDecryptFromBase64 } from '../secrets/osEncryption';
import { isLoopbackHostname } from '../assistant/rewriteLlmUrlForContainer';
import { secretPreview } from '../secrets/secretPreview';
import { dummyApiKeyForLocalLlm } from './LocalLlmDiscovery';
import { notifyConnectionSaved } from './onboardingExtensions';
import { isOpenRouterUrl, sameEndpoint } from '../../../shared/utils/endpointUrl';

const INFERENCE_SCHEMA_VERSION = 2;

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
  /** A shared model as the app default; `appDefault` is null while it is set (ADR 0036). */
  appSharedModel?: InferenceChainEntry;
  /** Slot entries tried after the app default (ADR 0033). Peer entries arrive with Circles. */
  appFallbacks?: InferenceChainEntry[];
  pendingProviderSetup?: PendingProviderSetup;
  /** OpenRouter's connection while disconnected. Outside `slots`, so nothing sends with it. */
  savedOpenRouterConnection?: StoredConnection;
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

/** Stored for a manually added local server saved without a key. */
const LOCAL_SERVER_PLACEHOLDER_API_KEY = 'local';

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

/**
 * Run a change to the connections and report it with the status after it. A thrown error becomes
 * the result's error. With `needsEncryption`, nothing runs while OS encryption is unavailable.
 */
async function withStatus(
  { needsEncryption = false }: { needsEncryption?: boolean },
  change: () => Promise<void>
): Promise<InferenceStatusResult> {
  if (needsEncryption && !(await isOsEncryptionAvailable())) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: await getOpenAiOnboardingStatus(),
    };
  }
  try {
    await change();
    return { success: true, status: await getOpenAiOnboardingStatus() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
}

/** Kept for the deploy experiment, which still imports it; Boundary code calls isOsEncryptionAvailable. */
export function isOpenAiConfigEncryptionAvailable(): Promise<boolean> {
  return isOsEncryptionAvailable();
}

function isLoopbackHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function classifyInferenceSlot(input: {
  provider?: string;
  capabilities?: LlmConnectionCapabilities;
  endpointUrl?: string;
}): InferenceSlotId {
  const provider = input.provider ?? '';
  const kind = input.capabilities?.kind;
  if (provider === 'openrouter' || kind === 'oauth' || isOpenRouterUrl(input.endpointUrl)) {
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

/** Raw reads and writes of the app inference choice. appInferenceChoice owns the rules for it. */
export const appChoiceStorage = {
  appDefault: (): InferenceSlotId | null => store.get('appDefault') ?? null,
  setAppDefault: (slot: InferenceSlotId | null): void => store.set('appDefault', slot),
  shared: (): InferenceChainEntry | null => store.get('appSharedModel') ?? null,
  setShared: (entry: InferenceChainEntry | null): void => {
    if (entry) store.set('appSharedModel', entry);
    else deleteStoreKey('appSharedModel');
  },
  fallbacks: (): InferenceChainEntry[] => store.get('appFallbacks') ?? [],
  setFallbacks: (entries: InferenceChainEntry[]): void => store.set('appFallbacks', entries),
};

function storedAppDefault(): InferenceSlotId | null {
  ensureV2Document();
  return appChoiceStorage.appDefault();
}

/** The slots as the chain rules see them, read once. */
export function storedChainSlots(): ChainSlots {
  ensureV2Document();
  const slots = readSlots();
  return {
    modelId: (slot) => slots[slot]?.modelId?.trim() || undefined,
    configured: (slot) => slotIsConfigured(slots[slot]),
  };
}

async function decryptApiKey(encrypted: string | undefined): Promise<string | null> {
  if (!encrypted) return null;
  return tryDecryptFromBase64(encrypted, (reEncrypted) => {
    const slots = readSlots();
    let changed = false;
    for (const slot of ['local', 'openrouter', 'infrastructure'] as const) {
      const connection = slots[slot];
      if (connection?.encryptedApiKey !== encrypted) continue;
      slots[slot] = { ...connection, encryptedApiKey: reEncrypted };
      changed = true;
    }
    if (changed) writeSlots(slots);
  });
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
    appChoiceStorage.setAppDefault(slot);
  } else if (!existingSlots) {
    writeSlots({});
    if (store.get('appDefault') === undefined) {
      appChoiceStorage.setAppDefault(null);
    }
  } else if (store.get('appDefault') === undefined) {
    appChoiceStorage.setAppDefault(null);
  }

  store.set('schemaVersion', INFERENCE_SCHEMA_VERSION);
  clearV1RootKeys();
}

async function slotHasMaterial(connection: StoredConnection | undefined): Promise<boolean> {
  if (!connection?.endpointUrl || !connection.encryptedApiKey) return false;
  return Boolean(await decryptApiKey(connection.encryptedApiKey));
}

async function slotIsConfigured(connection: StoredConnection | undefined): Promise<boolean> {
  return Boolean(
    (await slotHasMaterial(connection)) &&
      connection?.modelId?.trim() &&
      (await isOsEncryptionAvailable())
  );
}

async function buildSlotStatus(
  connection: StoredConnection | undefined,
  slot: InferenceSlotId
): Promise<LlmSlotStatus | undefined> {
  if (!connection?.endpointUrl && !connection?.encryptedApiKey) {
    return undefined;
  }
  const apiKey = await decryptApiKey(connection.encryptedApiKey);
  return {
    configured: await slotIsConfigured(connection),
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

export async function getOpenAiOnboardingStatus(): Promise<InferenceProvidersStatus> {
  ensureV2Document();
  const slots = readSlots();
  const appDefault = store.get('appDefault') ?? null;
  const encryptionAvailable = await isOsEncryptionAvailable();
  const defaultConnection = appDefault ? slots[appDefault] : undefined;
  const appSharedModel = appChoiceStorage.shared();
  const status: InferenceProvidersStatus = {
    // A shared model counts even while it can't serve: a send says why, and Settings offers others.
    configured: Boolean(appSharedModel) || (await slotIsConfigured(defaultConnection)),
    encryptionAvailable,
    appDefault,
    ...(appSharedModel ? { appSharedModel } : {}),
    appFallbacks: appChoiceStorage.fallbacks(),
    slots: {},
  };

  for (const slot of ['local', 'openrouter', 'infrastructure'] as const) {
    const slotStatus = await buildSlotStatus(slots[slot], slot);
    if (slotStatus) {
      status.slots[slot] = slotStatus;
    }
  }

  const pending = store.get('pendingProviderSetup');
  if (pending && !status.configured) {
    status.pending = pending;
  }

  const saved = store.get('savedOpenRouterConnection');
  if (saved) {
    status.savedOpenRouterKey = {
      preview: secretPreview(await decryptApiKey(saved.encryptedApiKey)).preview,
      modelId: saved.modelId?.trim() || undefined,
    };
  }
  return status;
}

export async function getSlotApiKey(slot: InferenceSlotId | null): Promise<string | null> {
  ensureV2Document();
  if (!slot) return null;
  return decryptApiKey(readSlots()[slot]?.encryptedApiKey);
}

/** Every stored model key, including OpenRouter's while disconnected. For masking only. */
export async function storedApiKeys(): Promise<string[]> {
  ensureV2Document();
  const connections = [...Object.values(readSlots()), store.get('savedOpenRouterConnection')];
  // One unreadable key leaves the others in.
  const keys = await Promise.all(
    connections.map((c) => decryptApiKey(c?.encryptedApiKey).catch((): null => null))
  );
  return keys.filter((key): key is string => Boolean(key));
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

async function materialFromStored(
  connection: StoredConnection | undefined
): Promise<(Omit<LlmConnection, 'modelId'> & { modelId?: string }) | null> {
  if (!connection) return null;
  const apiKey = await decryptApiKey(connection.encryptedApiKey);
  if (!connection.endpointUrl || !apiKey || !(await isOsEncryptionAvailable())) {
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
): Promise<(Omit<LlmConnection, 'modelId'> & { modelId?: string }) | null> {
  ensureV2Document();
  return materialFromStored(readSlots()[slot]);
}

/** Stored endpoint + key material for the app-default slot, even when model selection is still pending. */
export async function getStoredLlmConnectionMaterial(): Promise<(Omit<LlmConnection, 'modelId'> & {
  modelId?: string;
}) | null> {
  const slot = storedAppDefault();
  if (!slot) return null;
  return getSlotConnectionMaterial(slot);
}

export async function getSlotLlmConnection(slot: InferenceSlotId): Promise<LlmConnection | null> {
  const material = await getSlotConnectionMaterial(slot);
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

export async function getLlmConnection(): Promise<LlmConnection | null> {
  const slot = storedAppDefault();
  if (!slot) return null;
  return getSlotLlmConnection(slot);
}

function assignAppDefaultIfEmpty(slot: InferenceSlotId): void {
  if (!storedAppDefault() && !appChoiceStorage.shared()) {
    appChoiceStorage.setAppDefault(slot);
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
  const saved = slot === 'openrouter' ? store.get('savedOpenRouterConnection') : undefined;
  const existing = readSlots()[slot] ?? saved;
  const connection: StoredConnection = {
    endpointUrl: input.endpointUrl,
    encryptedApiKey: input.encryptedApiKey,
    provider: input.provider,
    providerDisplayName: input.providerDisplayName ?? '',
    authScheme: input.authScheme,
    capabilities: input.capabilities,
  };
  // Signing in again to the same provider and endpoint keeps the model picked earlier.
  const keptModelId =
    existing?.provider === input.provider && sameEndpoint(existing?.endpointUrl, input.endpointUrl)
      ? existing?.modelId
      : undefined;
  if (input.modelId ?? keptModelId) {
    connection.modelId = input.modelId ?? keptModelId;
  }
  if (input.extraHeaders) {
    connection.extraHeaders = input.extraHeaders;
  }
  if (input.lastSeenAt ?? existing?.lastSeenAt) {
    connection.lastSeenAt = input.lastSeenAt ?? existing?.lastSeenAt;
  }
  writeSlot(slot, connection);
  // The new key replaces a key kept by an earlier disconnect.
  if (saved) deleteStoreKey('savedOpenRouterConnection');
  assignAppDefaultIfEmpty(slot);
  deleteStoreKey('pendingProviderSetup');
  notifyConnectionSaved();
}

/**
 * Persist an OAuth-minted API key immediately after PKCE succeeds.
 * Model selection can happen later without forcing the user to sign in again.
 */
export async function saveOAuthCredentials(input: {
  providerId: string;
  providerDisplayName: string;
  endpointUrl: string;
  apiKey: string;
  authScheme: 'bearer' | 'api-key';
  capabilities: LlmConnectionCapabilities;
  extraHeaders?: Record<string, string>;
}): Promise<SaveLlmConnectionResult> {
  return withStatus({ needsEncryption: true }, async () => {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const apiKey = requireApiKey(input.apiKey);
    const encryptedApiKey = await encryptToBase64(apiKey);

    persistSlotConnection('openrouter', {
      endpointUrl,
      encryptedApiKey,
      provider: input.providerId,
      providerDisplayName: input.providerDisplayName,
      authScheme: input.authScheme,
      capabilities: input.capabilities,
      extraHeaders: input.extraHeaders,
    });
  });
}

export async function saveLlmConnection(input: SaveLlmConnectionInput): Promise<SaveLlmConnectionResult> {
  return withStatus({ needsEncryption: true }, async () => {
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
    // A blank key keeps the slot's stored key only while the slot stays on the same URL.
    const existing = readSlots()[slot];
    const storedKey = sameEndpoint(existing?.endpointUrl, endpointUrl) ? existing?.encryptedApiKey ?? '' : '';
    // A local server often needs no key; store a placeholder as saveLocalLlmEndpoint does.
    const encryptedApiKey = apiKey
      ? await encryptToBase64(apiKey)
      : storedKey || (slot === 'local' ? await encryptToBase64(LOCAL_SERVER_PLACEHOLDER_API_KEY) : '');
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
  });
}

export async function updateLlmModel(modelId: string, slot?: InferenceSlotId): Promise<UpdateLlmModelResult> {
  ensureV2Document();
  const target = slot ?? storedAppDefault();
  if (!target) {
    return {
      success: false,
      error: 'No LLM connection is configured.',
      status: await getOpenAiOnboardingStatus(),
    };
  }

  const connection = readSlots()[target];
  if (!connection || connection.capabilities?.modelChangePolicy !== 'selectable') {
    return {
      success: false,
      error: 'Model changes are not allowed for this connection.',
      status: await getOpenAiOnboardingStatus(),
    };
  }

  return withStatus({}, async () => {
    const normalizedModelId = requireModelId(modelId);
    writeSlot(target, { ...connection, modelId: normalizedModelId });
  });
}

export function getPendingProviderSetup(): PendingProviderSetup | undefined {
  return store.get('pendingProviderSetup');
}

export function setPendingProviderSetup(pending: PendingProviderSetup): Promise<InferenceProvidersStatus> {
  ensureV2Document();
  store.set('pendingProviderSetup', pending);
  return getOpenAiOnboardingStatus();
}

export function clearPendingProviderSetup(): Promise<InferenceProvidersStatus> {
  ensureV2Document();
  deleteStoreKey('pendingProviderSetup');
  return getOpenAiOnboardingStatus();
}

export async function saveLocalLlmEndpoint(input: {
  runtime: LocalLlmRuntime;
  endpointUrl: string;
  modelId: string;
}): Promise<SaveOpenAiConfigResult> {
  return withStatus({ needsEncryption: true }, async () => {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const modelId = requireModelId(input.modelId);
    const apiKey = dummyApiKeyForLocalLlm(input.runtime);
    const encryptedApiKey = await encryptToBase64(apiKey);
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
  });
}

async function nextDefaultAfterClear(cleared: InferenceSlotId): Promise<InferenceSlotId | null> {
  const slots = readSlots();
  for (const slot of ['local', 'openrouter'] as const) {
    if (slot !== cleared && (await slotIsConfigured(slots[slot]))) {
      return slot;
    }
  }
  if (cleared !== 'infrastructure' && (await slotIsConfigured(slots.infrastructure))) {
    return 'infrastructure';
  }
  return null;
}

export async function clearLlmSlot(slot: InferenceSlotId): Promise<ClearOpenAiConfigResult> {
  ensureV2Document();
  return withStatus({}, async () => {
    const wasDefault = storedAppDefault() === slot;
    const connection = readSlots()[slot];
    removeSlot(slot);
    // OpenRouter's key cost the user a sign-in, so disconnecting keeps it for a later reconnect.
    if (slot === 'openrouter' && connection?.encryptedApiKey) {
      store.set('savedOpenRouterConnection', connection);
    }
    if (wasDefault) {
      appChoiceStorage.setAppDefault(await nextDefaultAfterClear(slot));
    }
  });
}

/** Put a disconnected OpenRouter connection back, key and model included, with no sign-in. */
export async function reconnectSavedOpenRouterKey(): Promise<SaveLlmConnectionResult> {
  ensureV2Document();
  const saved = store.get('savedOpenRouterConnection');
  if (!saved || !(await decryptApiKey(saved.encryptedApiKey))) {
    return {
      success: false,
      error: 'The saved OpenRouter key can’t be read. Sign in to OpenRouter again.',
      status: await getOpenAiOnboardingStatus(),
    };
  }
  writeSlot('openrouter', saved);
  deleteStoreKey('savedOpenRouterConnection');
  assignAppDefaultIfEmpty('openrouter');
  deleteStoreKey('pendingProviderSetup');
  notifyConnectionSaved();
  return { success: true, status: await getOpenAiOnboardingStatus() };
}

export async function forgetSavedOpenRouterKey(): Promise<ClearOpenAiConfigResult> {
  ensureV2Document();
  deleteStoreKey('savedOpenRouterConnection');
  return { success: true, status: await getOpenAiOnboardingStatus() };
}

export async function clearOpenAiConfig(): Promise<ClearOpenAiConfigResult> {
  ensureV2Document();
  return withStatus({}, async () => {
    writeSlots({});
    appChoiceStorage.setAppDefault(null);
    deleteStoreKey('appSharedModel');
    deleteStoreKey('pendingProviderSetup');
    deleteStoreKey('savedOpenRouterConnection');
    ephemeralHealth.clear();
  });
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
