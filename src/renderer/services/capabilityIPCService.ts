import type {
  AcknowledgeCapabilityResult,
  CapabilityAssessment,
  CapabilityStatus,
} from '../../shared/types/capability';
import type {
  ContainerRuntimeDiagnostics,
  GetRuntimeDiagnosticsInput,
} from '../../shared/types/containerRuntimeDiagnostics';

export const capabilityIPC = {
  assess(): Promise<CapabilityAssessment> {
    return window.electronAPI.capability.assess();
  },

  getStatus(): Promise<CapabilityStatus> {
    return window.electronAPI.capability.getStatus();
  },

  acknowledge(): Promise<AcknowledgeCapabilityResult> {
    return window.electronAPI.capability.acknowledge();
  },

  getRuntimeDiagnostics(
    input?: GetRuntimeDiagnosticsInput
  ): Promise<ContainerRuntimeDiagnostics> {
    return window.electronAPI.capability.getRuntimeDiagnostics(input);
  },

  getDebugLog(): Promise<{ path: string; contents: string }> {
    return window.electronAPI.capability.getDebugLog();
  },

  onProgress(callback: (message: string) => void): () => void {
    return window.electronAPI.capability.onProgress(callback);
  },
};
