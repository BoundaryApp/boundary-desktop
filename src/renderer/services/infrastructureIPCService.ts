import type {
  CreateDeploymentInput,
  InfrastructurePrerequisites,
  InfrastructureStackInstance,
  ModelCatalogEntry,
  ProviderId,
  RunpodRuntimeSnapshot,
  ProviderRuntimeSnapshot,
  StackManifest,
  StackStatusSnapshot,
  TerraformCheckResult,
  TrussCheckResult,
} from '../../shared/types/infrastructure';

export const infrastructureIPC = {
  listCatalog(): Promise<ModelCatalogEntry[]> {
    return window.electronAPI.infrastructure.listCatalog();
  },

  listManifests(): Promise<StackManifest[]> {
    return window.electronAPI.infrastructure.listManifests();
  },

  listInstances(): Promise<InfrastructureStackInstance[]> {
    return window.electronAPI.infrastructure.listInstances();
  },

  createDeployment(input: CreateDeploymentInput) {
    return window.electronAPI.infrastructure.createInstance(input);
  },

  createInstance(stackTypeId: string, displayName?: string) {
    return window.electronAPI.infrastructure.createInstance(stackTypeId, displayName);
  },

  checkPrerequisites(provider: ProviderId, modelId?: string): Promise<InfrastructurePrerequisites> {
    return window.electronAPI.infrastructure.checkPrerequisites(provider, modelId);
  },

  deleteInstance(instanceId: string) {
    return window.electronAPI.infrastructure.deleteInstance(instanceId);
  },

  getVars(instanceId: string) {
    return window.electronAPI.infrastructure.getVars(instanceId);
  },

  saveVars(instanceId: string, vars: Record<string, string | number | boolean>) {
    return window.electronAPI.infrastructure.saveVars(instanceId, vars);
  },

  setSecret(instanceId: string, varName: string, value: string) {
    return window.electronAPI.infrastructure.setSecret(instanceId, varName, value);
  },

  apply(instanceId: string) {
    return window.electronAPI.infrastructure.apply(instanceId);
  },

  destroy(instanceId: string, confirmName: string) {
    return window.electronAPI.infrastructure.destroy(instanceId, {
      confirm: true,
      confirmName,
    });
  },

  cancel(instanceId: string) {
    return window.electronAPI.infrastructure.cancel(instanceId);
  },

  getStatus(instanceId: string): Promise<StackStatusSnapshot | null> {
    return window.electronAPI.infrastructure.getStatus(instanceId);
  },

  getRuntime(
    instanceId: string
  ): Promise<RunpodRuntimeSnapshot | ProviderRuntimeSnapshot | null> {
    return window.electronAPI.infrastructure.getRuntime(instanceId);
  },

  checkTerraform(): Promise<TerraformCheckResult> {
    return window.electronAPI.infrastructure.checkTerraform();
  },

  checkTruss(): Promise<TrussCheckResult> {
    return window.electronAPI.infrastructure.checkTruss();
  },

  subscribe() {
    return window.electronAPI.infrastructure.subscribe();
  },

  unsubscribe() {
    return window.electronAPI.infrastructure.unsubscribe();
  },

  onStatusChanged(callback: (snapshot: StackStatusSnapshot) => void) {
    window.electronAPI.infrastructure.onStatusChanged(callback);
  },
};
