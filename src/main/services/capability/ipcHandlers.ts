import { handle, handleResult } from '../../ipc';
import { readDebugLogTail } from '../../persistDebugLog';
import {
  acknowledgeHostCapability,
  assessHostCapability,
  getHostCapabilityStatus,
} from './HostCapabilityService';

export function registerCapabilityHandlers(): void {
  handle('capability:assess', async () => {
    return assessHostCapability();
  });

  handle('capability:get-status', async () => {
    return getHostCapabilityStatus();
  });

  handleResult('capability:acknowledge', async () => {
    return acknowledgeHostCapability();
  });

  handle('capability:get-debug-log', async () => {
    return readDebugLogTail();
  });
}
