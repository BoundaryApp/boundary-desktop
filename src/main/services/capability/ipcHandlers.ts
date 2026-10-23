import { ipcMain } from 'electron';
import { getContainerRuntimeDiagnostics } from '../containerRuntime/runtimeDiagnostics';
import type { GetRuntimeDiagnosticsInput } from '../../../shared/types/containerRuntimeDiagnostics';
import { readDebugLogTail } from '../../persistDebugLog';
import {
  acknowledgeHostCapability,
  assessHostCapability,
  getHostCapabilityStatus,
} from './HostCapabilityService';

export function registerCapabilityHandlers(): void {
  ipcMain.handle('capability:assess', async () => {
    return assessHostCapability();
  });

  ipcMain.handle('capability:get-status', async () => {
    return getHostCapabilityStatus();
  });

  ipcMain.handle('capability:acknowledge', async () => {
    return acknowledgeHostCapability();
  });

  ipcMain.handle(
    'capability:get-runtime-diagnostics',
    async (_event, input?: GetRuntimeDiagnosticsInput) => {
      return getContainerRuntimeDiagnostics({ refresh: Boolean(input?.refresh) });
    }
  );

  ipcMain.handle('capability:get-debug-log', async () => {
    return readDebugLogTail();
  });
}
