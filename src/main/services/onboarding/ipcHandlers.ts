import { ipcMain } from 'electron';
import {
  classifyInferenceSlot,
  clearLlmSlot,
  clearPendingProviderSetup,
  getAppDefaultSlot,
  getLlmConnection,
  getOpenAiOnboardingStatus,
  getSlotApiKey,
  getSlotConnectionMaterial,
  getStoredLlmConnectionMaterial,
  saveLlmConnection,
  saveLocalLlmEndpoint,
  saveOAuthCredentials,
  saveOpenAiConfig,
  saveProviderEndpoint,
  setAppDefault,
  setPendingProviderSetup,
  updateLlmModel,
} from './OpenAiOnboardingStore';
import { probeSlotHealth } from './probeSlotHealth';
import { clearSessionInferenceForProvider } from '../assistant/hermes/hermesAgentStore';
import { clearProjectInferenceForProvider } from '../assistant/hermes/hermesProjects';
import { isVisibleChatProvider } from '../../../shared/inferenceDisplay';
import { listEndpointModels } from './ModelListingService';
import { sendOnboardingTestMessage } from './OnboardingOpenAiClient';
import { cancelActiveOAuthPkceFlow, startOAuthPkceFlow } from './oauth/OAuthPkceFlowService';
import { listOAuthProviders } from './oauth/registry';
import {
  clearProviderFormDraft,
  getProviderFormDraft,
  resolveStoredDraftSecret,
  resolveStoredDraftSecrets,
  saveProviderFormDraft,
} from './ProviderFormDraftStore';
import { discoverBasetenOpenAiEndpoints, listBasetenDeployments } from './BasetenEndpointDiscovery';
import { dummyApiKeyForLocalLlm, discoverLocalLlms } from './LocalLlmDiscovery';
import { dismissLocalLlmOrigin } from './LocalLlmDismissStore';
import { hasLoadedLocalLlmModel, preferredLocalLlmModelId } from '../../../shared/localLlm';
import { listDeployableModels } from './DeployableModels';
import { infrastructureService } from '../infrastructure/InfrastructureService';
import { listCatalogModels } from '../infrastructure/CatalogLoader';
import { getRecipeForDeployment } from '../infrastructure/RecipeLoader';
import { verifyChatCompletionEndpoint } from '../infrastructure/endpointVerification';
import { taskService } from '../taskService';
import type { ProviderId } from '../../../shared/types/infrastructure';
import type {
  AdoptLocalLlmInput,
  AdoptLocalLlmResult,
  AdoptProviderEndpointInput,
  AdoptProviderEndpointResult,
  ClearProviderFormDraftInput,
  DiscoverProviderEndpointsInput,
  DiscoverProviderEndpointsResult,
  DismissLocalLlmInput,
  DismissLocalLlmResult,
  GetProviderFormDraftInput,
  ListDeployableModelsInput,
  ListDeployableModelsResult,
  ListProviderDeploymentsInput,
  ListProviderDeploymentsResult,
  OnboardingProviderConfig,
  OnboardingProviderId,
  SaveOpenAiConfigInput,
  SaveProviderFormDraftInput,
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
  StartProviderSetupInput,
  StartProviderSetupResult,
  SendLlmTestMessageInput,
  SendLlmTestMessageResult,
  UpdateLlmModelInput,
  UpdateLlmModelResult,
  ClearLlmSlotInput,
} from '../../../shared/types/onboarding';

let registered = false;

interface OnboardingProviderDefinition {
  id: OnboardingProviderId;
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
  capability: string;
  infrastructureProvider?: ProviderId;
  capabilities?: OnboardingProviderConfig['capabilities'];
}

const providerDefinitions: OnboardingProviderDefinition[] = [
  {
    id: 'baseten',
    name: 'Baseten',
    description: 'Deploy production inference endpoints with managed model hosting.',
    status: 'available',
    capability: 'OpenAI-compatible endpoint after deployment',
    infrastructureProvider: 'baseten',
    capabilities: {
      authFieldName: 'baseten_api_key',
      deploymentListing: true,
      endpointAdoption: true,
      deployableModels: true,
    },
  },
  {
    id: 'cerebrium',
    name: 'Cerebrium',
    description: 'Run serverless AI workloads with GPU-backed deployments.',
    status: 'available',
    capability: 'OpenAI-compatible vLLM endpoint after deployment',
    infrastructureProvider: 'cerebrium',
    capabilities: {
      deployableModels: true,
      accountCredentialFields: [
        'cerebrium_service_account_token',
        'cerebrium_project_id',
      ],
    },
  },
  {
    id: 'modal',
    name: 'Modal',
    description: 'Ship containerized model services on serverless compute.',
    status: 'coming-soon',
    capability: 'Provider setup flow planned',
    infrastructureProvider: 'modal',
  },
  {
    id: 'beam',
    name: 'Beam Cloud',
    description: 'Deploy GPU workloads behind an OpenAI-compatible API.',
    status: 'coming-soon',
    capability: 'Provider metadata ready; infrastructure driver not yet mapped',
  },
];

async function buildProviderConfigs(): Promise<OnboardingProviderConfig[]> {
  const catalog = await listCatalogModels();

  return Promise.all(
    providerDefinitions.map(async (provider) => {
      const deployment = provider.infrastructureProvider
        ? catalog
            .flatMap((model) =>
              model.deployments.map((dep) => ({
                model,
                deployment: dep,
              }))
            )
            .find(
              ({ deployment }) =>
                deployment.provider === provider.infrastructureProvider && deployment.available
            )
        : undefined;
      const recipe =
        deployment && provider.infrastructureProvider
          ? await getRecipeForDeployment(deployment.model.id, provider.infrastructureProvider)
          : null;

      return {
        ...provider,
        status: provider.status === 'available' && recipe ? 'available' : 'coming-soon',
        modelId: deployment?.model.id,
        fields: recipe?.secrets ?? [],
      };
    })
  );
}

async function startProviderSetup(
  input: StartProviderSetupInput
): Promise<StartProviderSetupResult> {
  const provider = (await buildProviderConfigs()).find((p) => p.id === input.providerId);
  if (!provider || provider.status !== 'available' || !provider.infrastructureProvider || !provider.modelId) {
    return { success: false, error: 'Provider setup is not available yet.' };
  }

  const modelId = input.modelId ?? provider.modelId;
  const recipe = await getRecipeForDeployment(modelId, provider.infrastructureProvider);
  if (!recipe) {
    return { success: false, error: 'The selected model is not deployable for this provider.' };
  }

  input = { ...input, values: await resolveStoredDraftSecrets(input.providerId, input.values) };
  const missing = recipe.secrets.find((field) => {
    if (!field.required) return false;
    const value = input.values[field.name];
    return value === undefined || value === '';
  });
  if (missing) {
    return { success: false, error: `Missing required value: ${missing.name}` };
  }

  const create = await infrastructureService.createInstance({
    modelId,
    provider: provider.infrastructureProvider,
    displayName: `${provider.name} OpenAI Endpoint`,
  });
  if (!create.success || !create.instance) {
    return { success: false, error: create.error ?? 'Unable to create provider instance.' };
  }

  const vars: Record<string, string | number | boolean> = {};
  for (const field of recipe.secrets) {
    const value = input.values[field.name];
    if (value === undefined || value === '') continue;
    if (field.sensitive) {
      const res = await infrastructureService.setSecret(create.instance.id, field.name, String(value));
      if (!res.success) {
        return { success: false, error: res.error ?? `Failed to save ${field.name}.` };
      }
    } else {
      vars[field.name] = value;
    }
  }

  if (Object.keys(vars).length > 0) {
    const res = await infrastructureService.saveVars(create.instance.id, vars);
    if (!res.success) {
      return { success: false, error: res.error ?? 'Failed to save provider configuration.' };
    }
  }

  const apply = await infrastructureService.apply(create.instance.id);
  if (!apply.success || !apply.taskId) {
    return { success: false, error: apply.error ?? 'Failed to start provider deployment.' };
  }

  const task = await taskService.getTask(apply.taskId);
  await taskService.updateTask({
    id: apply.taskId,
    metadata: {
      ...(task?.metadata ?? {}),
      onboardingProvider: provider.id,
    },
  });

  const pending = {
    providerId: provider.id,
    providerName: provider.name,
    instanceId: create.instance.id,
    taskId: apply.taskId,
    startedAt: new Date().toISOString(),
  };
  await setPendingProviderSetup(pending);

  return { success: true, pending };
}

async function discoverProviderEndpoints(
  input: DiscoverProviderEndpointsInput
): Promise<DiscoverProviderEndpointsResult> {
  if (input.providerId !== 'baseten') {
    return { success: false, endpoints: [], error: 'Endpoint discovery is not available for this provider.' };
  }

  const apiKey = (await resolveStoredDraftSecrets(input.providerId, input.values)).baseten_api_key;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return { success: false, endpoints: [], error: 'Enter a Baseten API key.' };
  }

  return discoverBasetenOpenAiEndpoints(apiKey.trim());
}

async function listProviderDeployments(
  input: ListProviderDeploymentsInput
): Promise<ListProviderDeploymentsResult> {
  if (input.providerId !== 'baseten') {
    return { success: false, endpoints: [], error: 'Deployment listing is not available for this provider.' };
  }

  const apiKey = (await resolveStoredDraftSecrets(input.providerId, input.values)).baseten_api_key;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return { success: false, endpoints: [], error: 'Enter a Baseten API key.' };
  }

  return listBasetenDeployments(apiKey.trim());
}

async function listProviderDeployableModels(
  input: ListDeployableModelsInput
): Promise<ListDeployableModelsResult> {
  return listDeployableModels(input.providerId, await resolveStoredDraftSecrets(input.providerId, input.values));
}

async function adoptProviderEndpoint(
  input: AdoptProviderEndpointInput
): Promise<AdoptProviderEndpointResult> {
  if (input.providerId !== 'baseten') {
    return { success: false, error: 'Endpoint adoption is not available for this provider.' };
  }
  input = { ...input, apiKey: await resolveStoredDraftSecret(input.providerId, input.apiKey) };
  if (!input.apiKey.trim()) {
    return { success: false, error: 'Enter a Baseten API key.' };
  }

  if (!input.modelId?.trim()) {
    return { success: false, error: 'Select a model for this endpoint.' };
  }

  const verification = await verifyChatCompletionEndpoint({
    baseUrl: input.endpointUrl,
    apiKey: input.apiKey.trim(),
    modelId: input.modelId.trim(),
    provider: 'baseten',
    authScheme: 'api-key',
  });
  if (!verification.ok) {
    return {
      success: false,
      error: verification.error ?? 'The selected endpoint did not return a valid chat response.',
    };
  }

  return saveProviderEndpoint({
    providerId: input.providerId,
    instanceId: `adopted:${input.modelId ?? input.endpointUrl}`,
    endpointUrl: input.endpointUrl,
    apiKey: input.apiKey.trim(),
    modelId: input.modelId.trim(),
    authScheme: 'api-key',
    providerDisplayName: 'Baseten',
  });
}

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

function dismissLocalLlm(input: DismissLocalLlmInput): DismissLocalLlmResult {
  try {
    dismissLocalLlmOrigin(input.runtime, input.endpointUrl);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function urlsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return left.replace(/\/$/, '') === right.replace(/\/$/, '');
}

async function saveLlmConnectionHandler(
  input: SaveLlmConnectionInput
): Promise<SaveLlmConnectionResult> {
  const slot = resolveSaveSlot(input);
  const stored = (await getSlotConnectionMaterial(slot)) ?? (await getStoredLlmConnectionMaterial());
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
  const authScheme = slotStatus.provider === 'baseten' ? 'api-key' : slotStatus.authScheme ?? 'bearer';
  const verified = await verifyChatCompletionEndpoint({
    baseUrl: slotStatus.endpointUrl,
    apiKey: storedKey ?? undefined,
    modelId: input.modelId,
    provider: slotStatus.provider,
    authScheme,
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
  const result = await clearLlmSlot(input.slot);
  if (result.success) {
    if (isVisibleChatProvider(input.slot)) {
      clearSessionInferenceForProvider(input.slot);
      clearProjectInferenceForProvider(input.slot);
    }
    const nextDefault = getAppDefaultSlot();
    if (nextDefault) {
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

  ipcMain.handle('onboarding:get-status', async () => getOpenAiOnboardingStatus());

  ipcMain.handle('onboarding:list-providers', async () => buildProviderConfigs());

  ipcMain.handle(
    'onboarding:discover-provider-endpoints',
    async (_event, input: DiscoverProviderEndpointsInput) => discoverProviderEndpoints(input)
  );

  ipcMain.handle(
    'onboarding:list-provider-deployments',
    async (_event, input: ListProviderDeploymentsInput) => listProviderDeployments(input)
  );

  ipcMain.handle(
    'onboarding:list-deployable-models',
    async (_event, input: ListDeployableModelsInput) => listProviderDeployableModels(input)
  );

  ipcMain.handle('onboarding:adopt-provider-endpoint', async (_event, input: AdoptProviderEndpointInput) =>
    adoptProviderEndpoint(input)
  );

  ipcMain.handle('onboarding:discover-local-llms', async () => discoverLocalLlms());

  ipcMain.handle('onboarding:adopt-local-llm', async (_event, input: AdoptLocalLlmInput) =>
    adoptLocalLlm(input)
  );

  ipcMain.handle('onboarding:dismiss-local-llm', async (_event, input: DismissLocalLlmInput) =>
    dismissLocalLlm(input)
  );

  ipcMain.handle('onboarding:start-provider-setup', async (_event, input: StartProviderSetupInput) =>
    startProviderSetup(input)
  );

  ipcMain.handle('onboarding:save-openai-config', async (_event, input: SaveOpenAiConfigInput) =>
    saveOpenAiConfig(input)
  );

  ipcMain.handle('onboarding:clear-openai-config', async (_event, input?: ClearLlmSlotInput) => {
    const slot = input?.slot ?? getAppDefaultSlot();
    if (!slot) {
      return { success: true, status: await getOpenAiOnboardingStatus() };
    }
    return clearSlotHandler({ slot });
  });

  ipcMain.handle('onboarding:clear-llm-slot', async (_event, input: ClearLlmSlotInput) =>
    clearSlotHandler(input)
  );

  ipcMain.handle('onboarding:set-app-default', async (_event, input: SetAppDefaultInput) =>
    setAppDefaultHandler(input)
  );

  ipcMain.handle('onboarding:probe-slot-health', async (_event, input: ProbeSlotHealthInput) =>
    probeSlotHealthHandler(input)
  );

  ipcMain.handle('onboarding:clear-pending-provider-setup', async () => clearPendingProviderSetup());

  ipcMain.handle(
    'onboarding:get-provider-form-draft',
    async (_event, input: GetProviderFormDraftInput) => getProviderFormDraft(input.providerId)
  );

  ipcMain.handle(
    'onboarding:save-provider-form-draft',
    async (_event, input: SaveProviderFormDraftInput) => saveProviderFormDraft(input)
  );

  ipcMain.handle(
    'onboarding:clear-provider-form-draft',
    async (_event, input?: ClearProviderFormDraftInput) =>
      clearProviderFormDraft(input?.providerId)
  );

  ipcMain.handle('onboarding:list-oauth-providers', async (): Promise<ListOAuthProvidersResult> => {
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

  ipcMain.handle(
    'onboarding:start-oauth-pkce',
    async (_event, input: StartOAuthPkceInput): Promise<StartOAuthPkceResult> => {
      try {
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
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle('onboarding:cancel-oauth-pkce', async (): Promise<CancelOAuthPkceResult> => {
    try {
      cancelActiveOAuthPkceFlow();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    'onboarding:list-endpoint-models',
    async (_event, input: ListEndpointModelsInput): Promise<ListEndpointModelsResult> => {
      if (!input.apiKey && input.baseUrl) {
        for (const slot of ['local', 'openrouter', 'infrastructure'] as const) {
          const stored = await getSlotConnectionMaterial(slot);
          if (stored && urlsMatch(stored.endpointUrl, input.baseUrl)) {
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

  ipcMain.handle(
    'onboarding:list-configured-endpoint-models',
    async (_event, input?: ListConfiguredEndpointModelsInput) =>
      listConfiguredEndpointModels(input)
  );

  ipcMain.handle(
    'onboarding:save-llm-connection',
    async (_event, input: SaveLlmConnectionInput) => saveLlmConnectionHandler(input)
  );

  ipcMain.handle(
    'onboarding:update-llm-model',
    async (_event, input: UpdateLlmModelInput) => updateLlmModelHandler(input)
  );

  ipcMain.handle(
    'onboarding:send-llm-test-message',
    async (_event, input: SendLlmTestMessageInput): Promise<SendLlmTestMessageResult> =>
      sendOnboardingTestMessage(input.message, input.slot)
  );
}
