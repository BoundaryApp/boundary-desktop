import type {
  ApplyAssistantLlmPayload,
  ApplyAssistantLlmResult,
  AssistantStackLifecycleSnapshot,
  AssistantStackStatus,
  EnsureAssistantStackResult,
  StopAssistantStackResult,
} from '../../shared/types/assistantStack';

export const assistantStackIPC = {
  getStatus(): Promise<AssistantStackStatus> {
    return window.electronAPI.assistantStack.getStatus();
  },
  getLifecycle(): Promise<AssistantStackLifecycleSnapshot> {
    return window.electronAPI.assistantStack.getLifecycle();
  },
  ensureRunning(): Promise<EnsureAssistantStackResult> {
    return window.electronAPI.assistantStack.ensureRunning();
  },
  ensureRunningInBackground(): Promise<{ started: boolean }> {
    return window.electronAPI.assistantStack.ensureRunningInBackground();
  },
  ensureAndApplyLlm(): Promise<EnsureAssistantStackResult> {
    return window.electronAPI.assistantStack.ensureAndApplyLlm();
  },
  applyLlm(payload?: ApplyAssistantLlmPayload): Promise<ApplyAssistantLlmResult> {
    return window.electronAPI.assistantStack.applyLlm(payload);
  },
  stop(): Promise<StopAssistantStackResult> {
    return window.electronAPI.assistantStack.stop();
  },
  resetInstall(): Promise<{ success: boolean; error?: string }> {
    return window.electronAPI.assistantStack.resetInstall();
  },
  onProgress(callback: (message: string) => void): () => void {
    return window.electronAPI.assistantStack.onProgress(callback);
  },
  onLifecycle(
    callback: (snapshot: AssistantStackLifecycleSnapshot) => void
  ): () => void {
    return window.electronAPI.assistantStack.onLifecycle(callback);
  },
};
