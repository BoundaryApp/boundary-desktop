import type {
  CancelOAuthPkceResult,
  ClearOpenAiConfigResult,
  ClearProviderFormDraftInput,
  ClearProviderFormDraftResult,
  AdoptLocalLlmInput,
  AdoptLocalLlmResult,
  AdoptProviderEndpointInput,
  AdoptProviderEndpointResult,
  DiscoverLocalLlmsResult,
  DiscoverProviderEndpointsInput,
  DiscoverProviderEndpointsResult,
  DismissLocalLlmInput,
  DismissLocalLlmResult,
  GetProviderFormDraftInput,
  GetProviderFormDraftResult,
  ListDeployableModelsInput,
  ListDeployableModelsResult,
  ListEndpointModelsInput,
  ListEndpointModelsResult,
  ListOAuthProvidersResult,
  ListProviderDeploymentsInput,
  ListProviderDeploymentsResult,
  InferenceProvidersStatus,
  ListConfiguredEndpointModelsInput,
  LocalLlmChangedPayload,
  OnboardingProviderConfig,
  ProbeSlotHealthInput,
  ProbeSlotHealthResult,
  SetAppDefaultInput,
  SetAppDefaultResult,
  ClearLlmSlotInput,
  SaveLlmConnectionInput,
  SaveLlmConnectionResult,
  SaveOpenAiConfigInput,
  SaveOpenAiConfigResult,
  SaveProviderFormDraftInput,
  SaveProviderFormDraftResult,
  StartOAuthPkceInput,
  StartOAuthPkceResult,
  StartProviderSetupInput,
  StartProviderSetupResult,
  SendLlmTestMessageInput,
  SendLlmTestMessageResult,
  UpdateLlmModelInput,
  UpdateLlmModelResult,
} from '../../shared/types/onboarding';

export const onboardingIPC = {
  getStatus(): Promise<InferenceProvidersStatus> {
    return window.electronAPI.onboarding.getStatus();
  },

  listProviders(): Promise<OnboardingProviderConfig[]> {
    return window.electronAPI.onboarding.listProviders();
  },

  discoverProviderEndpoints(
    input: DiscoverProviderEndpointsInput
  ): Promise<DiscoverProviderEndpointsResult> {
    return window.electronAPI.onboarding.discoverProviderEndpoints(input);
  },

  listProviderDeployments(
    input: ListProviderDeploymentsInput
  ): Promise<ListProviderDeploymentsResult> {
    return window.electronAPI.onboarding.listProviderDeployments(input);
  },

  listDeployableModels(input: ListDeployableModelsInput): Promise<ListDeployableModelsResult> {
    return window.electronAPI.onboarding.listDeployableModels(input);
  },

  adoptProviderEndpoint(input: AdoptProviderEndpointInput): Promise<AdoptProviderEndpointResult> {
    return window.electronAPI.onboarding.adoptProviderEndpoint(input);
  },

  startProviderSetup(input: StartProviderSetupInput): Promise<StartProviderSetupResult> {
    return window.electronAPI.onboarding.startProviderSetup(input);
  },

  saveOpenAiConfig(input: SaveOpenAiConfigInput): Promise<SaveOpenAiConfigResult> {
    return window.electronAPI.onboarding.saveOpenAiConfig(input);
  },

  saveLlmConnection(input: SaveLlmConnectionInput): Promise<SaveLlmConnectionResult> {
    return window.electronAPI.onboarding.saveLlmConnection(input);
  },

  updateLlmModel(input: UpdateLlmModelInput): Promise<UpdateLlmModelResult> {
    return window.electronAPI.onboarding.updateLlmModel(input);
  },

  clearOpenAiConfig(input?: ClearLlmSlotInput): Promise<ClearOpenAiConfigResult> {
    return window.electronAPI.onboarding.clearOpenAiConfig(input);
  },

  clearLlmSlot(input: ClearLlmSlotInput): Promise<ClearOpenAiConfigResult> {
    return window.electronAPI.onboarding.clearLlmSlot(input);
  },

  setAppDefault(input: SetAppDefaultInput): Promise<SetAppDefaultResult> {
    return window.electronAPI.onboarding.setAppDefault(input);
  },

  probeSlotHealth(input: ProbeSlotHealthInput): Promise<ProbeSlotHealthResult> {
    return window.electronAPI.onboarding.probeSlotHealth(input);
  },

  clearPendingProviderSetup(): Promise<InferenceProvidersStatus> {
    return window.electronAPI.onboarding.clearPendingProviderSetup();
  },

  getProviderFormDraft(input: GetProviderFormDraftInput): Promise<GetProviderFormDraftResult> {
    return window.electronAPI.onboarding.getProviderFormDraft(input);
  },

  saveProviderFormDraft(input: SaveProviderFormDraftInput): Promise<SaveProviderFormDraftResult> {
    return window.electronAPI.onboarding.saveProviderFormDraft(input);
  },

  clearProviderFormDraft(input?: ClearProviderFormDraftInput): Promise<ClearProviderFormDraftResult> {
    return window.electronAPI.onboarding.clearProviderFormDraft(input);
  },

  discoverLocalLlms(): Promise<DiscoverLocalLlmsResult> {
    return window.electronAPI.onboarding.discoverLocalLlms();
  },

  adoptLocalLlm(input: AdoptLocalLlmInput): Promise<AdoptLocalLlmResult> {
    return window.electronAPI.onboarding.adoptLocalLlm(input);
  },

  dismissLocalLlm(input: DismissLocalLlmInput): Promise<DismissLocalLlmResult> {
    return window.electronAPI.onboarding.dismissLocalLlm(input);
  },

  listOAuthProviders(): Promise<ListOAuthProvidersResult> {
    return window.electronAPI.onboarding.listOAuthProviders();
  },

  startOAuthPkce(input: StartOAuthPkceInput): Promise<StartOAuthPkceResult> {
    return window.electronAPI.onboarding.startOAuthPkce(input);
  },

  cancelOAuthPkce(): Promise<CancelOAuthPkceResult> {
    return window.electronAPI.onboarding.cancelOAuthPkce();
  },

  listEndpointModels(input: ListEndpointModelsInput): Promise<ListEndpointModelsResult> {
    return window.electronAPI.onboarding.listEndpointModels(input);
  },

  listConfiguredEndpointModels(
    input?: ListConfiguredEndpointModelsInput
  ): Promise<ListEndpointModelsResult> {
    return window.electronAPI.onboarding.listConfiguredEndpointModels(input);
  },

  sendLlmTestMessage(input: SendLlmTestMessageInput): Promise<SendLlmTestMessageResult> {
    return window.electronAPI.onboarding.sendLlmTestMessage(input);
  },

  onLocalLlmChanged(callback: (payload: LocalLlmChangedPayload) => void): () => void {
    return window.electronAPI.onboarding.onLocalLlmChanged(callback);
  },
};
