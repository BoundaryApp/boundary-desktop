import Store from 'electron-store';
import { LOCAL_LLM_CAPABILITIES } from '../../../shared/llmConnectionDefaults';
import type {
  InferenceProvidersStatus,
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
  SetAppDefaultResult,
  SetAppFallbacksResult,
  UpdateLlmModelResult,
} from '../../../shared/types/onboarding';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { isVisibleChatProvider } from '../../../shared/inferenceDisplay';
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

export function getAppDefaultSlot(): InferenceSlotId | null {
  ensureV2Document();
  return store.get('appDefault') ?? null;
}

function setStoredAppDefault(slot: InferenceSlotId | null): void {
  store.set('appDefault', slot);
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
  const status: InferenceProvidersStatus = {
    configured: await slotIsConfigured(defaultConnection),
    encryptionAvailable,
    appDefault,
    appFallbacks: getAppFallbacks(),
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
  const slot = getAppDefaultSlot();
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
  const slot = getAppDefaultSlot();
  if (!slot) return null;
  return getSlotLlmConnection(slot);
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
  if (!(await isOsEncryptionAvailable())) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: await getOpenAiOnboardingStatus(),
    };
  }

  try {
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

    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
}

export async function saveLlmConnection(input: SaveLlmConnectionInput): Promise<SaveLlmConnectionResult> {
  if (!(await isOsEncryptionAvailable())) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: await getOpenAiOnboardingStatus(),
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

    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
}

export async function updateLlmModel(modelId: string, slot?: InferenceSlotId): Promise<UpdateLlmModelResult> {
  ensureV2Document();
  const target = slot ?? getAppDefaultSlot();
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

  try {
    const normalizedModelId = requireModelId(modelId);
    writeSlot(target, { ...connection, modelId: normalizedModelId });
    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
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
  if (!(await isOsEncryptionAvailable())) {
    return {
      success: false,
      error: 'OS encryption is not available for storing API keys.',
      status: await getOpenAiOnboardingStatus(),
    };
  }

  try {
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

    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
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
  try {
    const wasDefault = getAppDefaultSlot() === slot;
    const connection = readSlots()[slot];
    removeSlot(slot);
    // OpenRouter's key cost the user a sign-in, so disconnecting keeps it for a later reconnect.
    if (slot === 'openrouter' && connection?.encryptedApiKey) {
      store.set('savedOpenRouterConnection', connection);
    }
    if (wasDefault) {
      setStoredAppDefault(await nextDefaultAfterClear(slot));
    }
    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
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
  try {
    writeSlots({});
    setStoredAppDefault(null);
    deleteStoreKey('pendingProviderSetup');
    deleteStoreKey('savedOpenRouterConnection');
    ephemeralHealth.clear();
    return {
      success: true,
      status: await getOpenAiOnboardingStatus(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      status: await getOpenAiOnboardingStatus(),
    };
  }
}

export async function setAppDefault(slot: InferenceSlotId): Promise<SetAppDefaultResult> {
  ensureV2Document();
  const connection = readSlots()[slot];
  if (!(await slotIsConfigured(connection))) {
    return {
      success: false,
      error: 'Connect that provider before making it the app default.',
      status: await getOpenAiOnboardingStatus(),
    };
  }
  setStoredAppDefault(slot);
  return {
    success: true,
    status: await getOpenAiOnboardingStatus(),
  };
}

export function getAppFallbacks(): InferenceChainEntry[] {
  ensureV2Document();
  return store.get('appFallbacks') ?? [];
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * Check a chain's fallbacks against its first entry. Only connected chat providers and
 * well-formed shared models are accepted, each slot and model once, and never the first
 * entry's own slot and model. A shared model is kept even while it is stale, so the user
 * sees it (ADR 0033 §10).
 */
export async function keepChainFallbacks(
  primary: { slot: InferenceSlotId; modelId?: string } | null,
  entries: InferenceChainEntry[]
): Promise<{ ok: true; fallbacks: InferenceChainEntry[] } | { ok: false; error: string }> {
  ensureV2Document();
  const slots = readSlots();
  const modelFor = (entry: InferenceChainEntry) =>
    entry.modelId?.trim() || (entry.slot === 'peer' ? '' : slots[entry.slot]?.modelId?.trim()) || '';
  const seen = new Set<string>(primary ? [`${primary.slot}:${modelFor(primary)}`] : []);
  const fallbacks: InferenceChainEntry[] = [];
  for (const entry of entries) {
    if (entry.slot === 'peer') {
      const modelId = entry.modelId?.trim() ?? '';
      const { circleId, providerId } = entry.peer ?? { circleId: '', providerId: '' };
      if (!HEX_KEY.test(circleId) || !HEX_KEY.test(providerId) || !modelId || modelId.length > 200) {
        return { ok: false, error: 'That shared model isn’t one Boundary knows.' };
      }
      const key = `peer:${circleId}:${providerId}:${modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fallbacks.push({ slot: 'peer', modelId, peer: { circleId, providerId } });
      continue;
    }
    // Fallbacks are the providers a chat can switch to; infrastructure stays hidden (ADR 0015 §3).
    if (!isVisibleChatProvider(entry.slot) || !(await slotIsConfigured(slots[entry.slot]))) {
      return { ok: false, error: 'Connect that provider before adding it as a fallback.' };
    }
    const key = `${entry.slot}:${modelFor(entry)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A blank model follows the slot's own model when that changes later.
    const picked = entry.modelId?.trim();
    fallbacks.push({ slot: entry.slot, ...(picked ? { modelId: picked } : {}) });
  }
  return { ok: true, fallbacks };
}

/**
 * Store the app default's fallbacks (see keepChainFallbacks). Saving doesn't restart Hermes;
 * the next send pushes the chain to the router (ADR 0033 §9).
 */
export async function setAppFallbacks(entries: InferenceChainEntry[]): Promise<SetAppFallbacksResult> {
  ensureV2Document();
  const appDefault = store.get('appDefault') ?? null;
  const kept = await keepChainFallbacks(appDefault ? { slot: appDefault } : null, entries);
  if (kept.ok === false) {
    return { success: false, error: kept.error, status: await getOpenAiOnboardingStatus() };
  }
  store.set('appFallbacks', kept.fallbacks);
  return { success: true, status: await getOpenAiOnboardingStatus() };
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
