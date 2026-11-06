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
  setN8nRunning,
  setLightragRunning,
  getWebSearchModeState,
  setWebSearchModeRunning,
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

  handleResult('assistant-stack:set-n8n-enabled', async (_event, enabled) =>
    setN8nRunning(enabled === true)
  );
  handleResult('assistant-stack:set-lightrag-enabled', async (_event, enabled) =>
    setLightragRunning(enabled === true)
  );
  handle('assistant-stack:get-web-search-mode', async () => getWebSearchModeState());
  handleResult('assistant-stack:set-web-search-mode', async (_event, mode) =>
    setWebSearchModeRunning(mode)
  );
}
