import { handle, handleResult } from '../../ipc';
import {
  classifyInferenceSlot,
  clearLlmSlot,
  getAppDefaultSlot,
  getLlmConnection,
  getOpenAiOnboardingStatus,
  getSlotApiKey,
  getSlotConnectionMaterial,
  getStoredLlmConnectionMaterial,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
  setAppDefault,
  updateLlmModel,
} from './OpenAiOnboardingStore';
import { probeSlotHealth } from './probeSlotHealth';
import {
  clearSessionInferenceForProvider,
  retargetSessionInferenceModel,
} from '../assistant/hermes/hermesAgentStore';
import {
  clearProjectInferenceForProvider,
  retargetProjectInferenceModel,
} from '../assistant/hermes/hermesProjects';
import { isVisibleChatProvider } from '../../../shared/inferenceDisplay';
import { listEndpointModels } from './ModelListingService';
import { sendOnboardingTestMessage } from './OnboardingOpenAiClient';
import { cancelActiveOAuthPkceFlow, startOAuthPkceFlow } from './oauth/OAuthPkceFlowService';
import { listOAuthProviders } from './oauth/registry';
import { dummyApiKeyForLocalLlm, discoverLocalLlms } from './LocalLlmDiscovery';
import { hasLoadedLocalLlmModel, preferredLocalLlmModelId } from '../../../shared/localLlm';
import { verifyChatCompletionEndpoint } from './endpointVerification';
import { sameEndpoint } from '../../../shared/utils/endpointUrl';
import type {
  AdoptLocalLlmInput,
  AdoptLocalLlmResult,
  CancelOAuthPkceResult,
  ListEndpointModelsInput,
  ListEndpointModelsResult,
  InferenceSlotId,
  ListConfiguredEndpointModelsInput,
  ListOAuthProvidersResult,
  ProbeSlotHealthInput,
  ProbeSlotHealthResult,
  SaveLlmConnectionInput,
  SaveLlmConnectionResult,
  SetAppDefaultInput,
  SetAppDefaultResult,
  StartOAuthPkceInput,
  StartOAuthPkceResult,
  SendLlmTestMessageInput,
  SendLlmTestMessageResult,
  UpdateLlmModelInput,
  UpdateLlmModelResult,
  ClearLlmSlotInput,
} from '../../../shared/types/onboarding';

let registered = false;

async function adoptLocalLlm(input: AdoptLocalLlmInput): Promise<AdoptLocalLlmResult> {
  const discovery = await discoverLocalLlms();
  const endpoint = discovery.endpoints.find((item) => item.runtime === input.runtime);
  if (!endpoint) {
    const name = input.runtime === 'ollama' ? 'Ollama' : 'LM Studio';
    return { success: false, error: `${name} is no longer reachable.` };
  }

  const modelId = input.modelId ?? preferredLocalLlmModelId(endpoint);
  if (!input.modelId && !hasLoadedLocalLlmModel(endpoint)) {
    return { success: false, error: 'No model is loaded on this local server yet.' };
  }
  if (!modelId) {
    return { success: false, error: 'No model is loaded on this local server yet.' };
  }

  const dummyKey = dummyApiKeyForLocalLlm(input.runtime);
  const verification = await verifyChatCompletionEndpoint({
    baseUrl: input.endpointUrl,
    apiKey: dummyKey,
    modelId,
    provider: input.runtime,
  });
  if (!verification.ok) {
    return {
      success: false,
      error: verification.error ?? 'The selected endpoint did not return a valid chat response.',
    };
  }

  const result = await saveLocalLlmEndpoint({
    runtime: input.runtime,
    endpointUrl: input.endpointUrl,
    modelId,
  });
  if (result.success) {
    await applyHermesIfDefaultSlot('local');
  }
  return result;
}

function resolveSaveSlot(input: SaveLlmConnectionInput): InferenceSlotId {
  return (
    input.slot ??
    classifyInferenceSlot({
      provider: input.provider,
      capabilities: input.capabilities,
      endpointUrl: input.endpointUrl,
    })
  );
}

async function applyHermesIfDefaultSlot(writtenSlot?: InferenceSlotId): Promise<void> {
  const appDefault = getAppDefaultSlot();
  if (!appDefault) return;
  if (writtenSlot && writtenSlot !== appDefault) return;
  if (!(await getLlmConnection())) return;

  try {
    const { applyLlmConnectionToHermes, isAssistantStackReady } = await import(
      '../assistant/AssistantStackService'
    );
    if (await isAssistantStackReady()) {
      const applied = await applyLlmConnectionToHermes();
      if (!applied.success) {
        console.warn('[assistant-stack] Failed to sync LLM into Hermes:', applied.error);
      }
    }
  } catch (error) {
    console.warn('[assistant-stack] LLM sync skipped:', error);
  }
}

async function saveLlmConnectionHandler(
  input: SaveLlmConnectionInput
): Promise<SaveLlmConnectionResult> {
  const slot = resolveSaveSlot(input);
  // A stored key is only sent to the URL it was saved with, and never to another slot's endpoint.
  const slotMaterial = await getSlotConnectionMaterial(slot);
  const stored = slotMaterial && sameEndpoint(slotMaterial.endpointUrl, input.endpointUrl) ? slotMaterial : null;
  const apiKey = input.apiKey?.trim() || stored?.apiKey;
  const authScheme = input.authScheme ?? stored?.authScheme;
  const verification = await verifyChatCompletionEndpoint({
    baseUrl: input.endpointUrl,
    apiKey,
    modelId: input.modelId,
    provider: input.provider,
    authScheme,
  });
  if (!verification.ok) {
    return {
      success: false,
      error: verification.error ?? 'The selected endpoint did not return a valid chat response.',
      status: await getOpenAiOnboardingStatus(),
    };
  }

  const result = await saveLlmConnection({
    ...input,
    slot,
    apiKey,
    authScheme,
    extraHeaders: input.extraHeaders ?? stored?.extraHeaders,
  });

  if (result.success) {
    await applyHermesIfDefaultSlot(slot);
  }

  return result;
}

async function updateLlmModelHandler(input: UpdateLlmModelInput): Promise<UpdateLlmModelResult> {
  const slot = input.slot ?? getAppDefaultSlot();
  const status = await getOpenAiOnboardingStatus();
  const slotStatus = slot ? status.slots[slot] : undefined;
  if (!slot || !slotStatus?.configured || !slotStatus.endpointUrl) {
    return {
      success: false,
      error: 'No LLM connection is configured.',
      status,
    };
  }

  const storedKey = await getSlotApiKey(slot);
  const verified = await verifyChatCompletionEndpoint({
    baseUrl: slotStatus.endpointUrl,
    apiKey: storedKey ?? undefined,
    modelId: input.modelId,
    provider: slotStatus.provider,
    authScheme: slotStatus.authScheme,
  });
  if (!verified.ok) {
    return {
      success: false,
      error: verified.error ?? 'The selected model did not return a valid chat response.',
      status,
    };
  }

  const result = await updateLlmModel(input.modelId, slot);
  if (result.success) {
    if (isVisibleChatProvider(slot)) {
      const modelId = input.modelId.trim();
      retargetSessionInferenceModel(slot, modelId);
      retargetProjectInferenceModel(slot, modelId);
    }
    await applyHermesIfDefaultSlot(slot);
  }
  return result;
}

async function listConfiguredEndpointModels(
  input?: ListConfiguredEndpointModelsInput
): Promise<ListEndpointModelsResult> {
  const slot = input?.slot ?? getAppDefaultSlot();
  const connection = slot ? await getSlotConnectionMaterial(slot) : await getStoredLlmConnectionMaterial();
  if (!connection) {
    return { success: false, models: [], error: 'No LLM connection is configured.' };
  }

  return listEndpointModels({
    baseUrl: connection.endpointUrl,
    apiKey: connection.apiKey,
    authScheme: connection.authScheme,
    provider: connection.provider,
    extraHeaders: connection.extraHeaders,
  });
}

async function setAppDefaultHandler(input: SetAppDefaultInput): Promise<SetAppDefaultResult> {
  const result = await setAppDefault(input.slot);
  if (result.success) {
    await applyHermesIfDefaultSlot(input.slot);
  }
  return result;
}

async function clearSlotHandler(input: ClearLlmSlotInput): Promise<SaveLlmConnectionResult> {
  // Hermes only needs the new connection when the cleared slot was the app default.
  const wasDefault = getAppDefaultSlot() === input.slot;
  const result = await clearLlmSlot(input.slot);
  if (result.success) {
    if (isVisibleChatProvider(input.slot)) {
      clearSessionInferenceForProvider(input.slot);
      clearProjectInferenceForProvider(input.slot);
    }
    const nextDefault = getAppDefaultSlot();
    if (wasDefault && nextDefault) {
      await applyHermesIfDefaultSlot(nextDefault);
    }
  }
  return result;
}

async function probeSlotHealthHandler(input: ProbeSlotHealthInput): Promise<ProbeSlotHealthResult> {
  return probeSlotHealth(input.slot);
}

export function registerOnboardingHandlers(): void {
  if (registered) return;
  registered = true;

  handle('onboarding:get-status', async () => getOpenAiOnboardingStatus());

  handleResult('onboarding:discover-local-llms', async () => discoverLocalLlms());

  handleResult('onboarding:adopt-local-llm', async (_event, input: AdoptLocalLlmInput) =>
    adoptLocalLlm(input)
  );

  handleResult('onboarding:clear-llm-slot', async (_event, input: ClearLlmSlotInput) =>
    clearSlotHandler(input)
  );

  handleResult('onboarding:set-app-default', async (_event, input: SetAppDefaultInput) =>
    setAppDefaultHandler(input)
  );

  handleResult('onboarding:probe-slot-health', async (_event, input: ProbeSlotHealthInput) =>
    probeSlotHealthHandler(input)
  );

  handleResult('onboarding:list-oauth-providers', async (): Promise<ListOAuthProvidersResult> => {
    try {
      const providers = listOAuthProviders().map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
      }));
      return { success: true, providers };
    } catch (error) {
      return {
        success: false,
        providers: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  handleResult(
    'onboarding:start-oauth-pkce',
    async (_event, input: StartOAuthPkceInput): Promise<StartOAuthPkceResult> => {
      const credentials = await startOAuthPkceFlow(input.providerId);
      const persisted = await saveOAuthCredentials({
        providerId: credentials.providerId,
        providerDisplayName: credentials.providerDisplayName,
        endpointUrl: credentials.endpointUrl,
        apiKey: credentials.apiKey,
        authScheme: credentials.authScheme,
        capabilities: credentials.capabilities,
        extraHeaders: credentials.extraHeaders,
      });
      if (!persisted.success) {
        return {
          success: false,
          error: persisted.error ?? 'Unable to store OAuth credentials securely.',
        };
      }
      // Key is already encrypted on disk; do not send it back to the renderer.
      return {
        success: true,
        credentials: {
          providerId: credentials.providerId,
          providerDisplayName: credentials.providerDisplayName,
          endpointUrl: credentials.endpointUrl,
          authScheme: credentials.authScheme,
          capabilities: credentials.capabilities,
          extraHeaders: credentials.extraHeaders,
        },
      };
    }
  );

  handleResult('onboarding:cancel-oauth-pkce', async (): Promise<CancelOAuthPkceResult> => {
    cancelActiveOAuthPkceFlow();
    return { success: true };
  });

  handleResult(
    'onboarding:list-endpoint-models',
    async (_event, input: ListEndpointModelsInput): Promise<ListEndpointModelsResult> => {
      if (!input.apiKey && input.baseUrl) {
        for (const slot of ['local', 'openrouter', 'infrastructure'] as const) {
          const stored = await getSlotConnectionMaterial(slot);
          if (stored && sameEndpoint(stored.endpointUrl, input.baseUrl)) {
            return listEndpointModels({
              ...input,
              apiKey: stored.apiKey,
              authScheme: input.authScheme ?? stored.authScheme,
              extraHeaders: input.extraHeaders ?? stored.extraHeaders,
              provider: input.provider ?? stored.provider,
            });
          }
        }
      }
      return listEndpointModels(input);
    }
  );

  handleResult(
    'onboarding:list-configured-endpoint-models',
    async (_event, input?: ListConfiguredEndpointModelsInput) =>
      listConfiguredEndpointModels(input)
  );

  handleResult(
    'onboarding:save-llm-connection',
    async (_event, input: SaveLlmConnectionInput) => saveLlmConnectionHandler(input)
  );

  handleResult(
    'onboarding:update-llm-model',
    async (_event, input: UpdateLlmModelInput) => updateLlmModelHandler(input)
  );

  handleResult(
    'onboarding:send-llm-test-message',
    async (_event, input: SendLlmTestMessageInput): Promise<SendLlmTestMessageResult> =>
      sendOnboardingTestMessage(input.message, input.slot)
  );
}
