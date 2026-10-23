import { BrowserWindow, ipcMain } from 'electron';
import {
  applyLlmConnectionToHermes,
  applyLlmSlotToHermes,
  ensureAssistantStackAndApplyLlm,
  ensureAssistantStackRunning,
  ensureAssistantStackRunningInBackground,
  getAssistantStackLifecycle,
  getAssistantStackStatus,
  resetBoundaryAssistantStackInstall,
  setAssistantStackLifecycleCallback,
  setAssistantStackProgressCallback,
  stopAssistantStack,
} from './AssistantStackService';
import { markAssistantStackSetupComplete } from './AssistantStackStore';
import type {
  ApplyAssistantLlmPayload,
  AssistantStackLifecycleSnapshot,
} from '../../../shared/types/assistantStack';

function broadcastProgress(message: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('assistant-stack:progress', message);
    }
  }
}

function broadcastLifecycle(snapshot: AssistantStackLifecycleSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('assistant-stack:lifecycle', snapshot);
    }
  }
}

export function registerAssistantStackHandlers(): void {
  setAssistantStackProgressCallback(broadcastProgress);
  setAssistantStackLifecycleCallback(broadcastLifecycle);

  ipcMain.handle('assistant-stack:get-status', async () => getAssistantStackStatus());

  ipcMain.handle('assistant-stack:get-lifecycle', async () => getAssistantStackLifecycle());

  ipcMain.handle('assistant-stack:ensure-running', async () => ensureAssistantStackRunning());

  ipcMain.handle('assistant-stack:ensure-running-background', async () => {
    ensureAssistantStackRunningInBackground();
    return { started: true };
  });

  ipcMain.handle('assistant-stack:ensure-and-apply-llm', async () => ensureAssistantStackAndApplyLlm());

  ipcMain.handle(
    'assistant-stack:apply-llm',
    async (_event, payload?: ApplyAssistantLlmPayload) => {
      if (payload?.slot) {
        return applyLlmSlotToHermes(payload.slot);
      }
      return applyLlmConnectionToHermes();
    }
  );

  ipcMain.handle('assistant-stack:stop', async () => stopAssistantStack());

  ipcMain.handle('assistant-stack:mark-setup-complete', async () => {
    markAssistantStackSetupComplete();
    return getAssistantStackStatus();
  });

  ipcMain.handle('assistant-stack:reset-install', async () => resetBoundaryAssistantStackInstall());
}
