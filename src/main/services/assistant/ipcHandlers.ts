import { handle, handleResult } from '../../ipc';
import { broadcast } from '../windows';
import {
  ensureAssistantStackAndApplyLlm,
  ensureAssistantStackRunning,
  ensureAssistantStackRunningInBackground,
  getAssistantStackLifecycle,
  getAssistantStackStatus,
  setAssistantStackLifecycleCallback,
  setAssistantStackReadyCallback,
} from './AssistantStackService';
import { createStartupNotifier } from './startupNotice';
import type { AssistantStackLifecycleSnapshot } from '../../../shared/types/assistantStack';

const noticeStartup = createStartupNotifier();

function broadcastLifecycle(snapshot: AssistantStackLifecycleSnapshot): void {
  noticeStartup(snapshot);
  broadcast('assistant-stack:lifecycle', snapshot);
}

export function registerAssistantStackHandlers(): void {
  setAssistantStackLifecycleCallback(broadcastLifecycle);
  setAssistantStackReadyCallback((ready) => broadcast('assistant-stack:ready', ready));

  handle('assistant-stack:get-status', async () => getAssistantStackStatus());

  handle('assistant-stack:get-lifecycle', async () => getAssistantStackLifecycle());

  handleResult('assistant-stack:ensure-running', async () => ensureAssistantStackRunning());

  handle('assistant-stack:ensure-running-background', async () => {
    ensureAssistantStackRunningInBackground();
    return { started: true };
  });

  handleResult('assistant-stack:ensure-and-apply-llm', async () => ensureAssistantStackAndApplyLlm());
}
