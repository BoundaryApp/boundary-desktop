import { ipcMain } from 'electron';
import type { FirstRunFolder, OptionalSetupOutcome } from '../../../shared/types/setupProgress';
import { isAssistantStackSetupComplete } from '../assistant/AssistantStackStore';
import { listStoredHermesProjects } from '../assistant/hermes/hermesProjectStore';
import {
  getSetupProgress,
  recordOptionalStepOutcome,
  recordSetupHistoryOnce,
} from './SetupProgressStore';
import { applyFirstRunFolders, pickFirstRunFolders, saveFirstRunFolders } from './firstRunFolders';

export function registerSetupHandlers(): void {
  // Before any handler runs, so setup finishing in this version can't count as an upgrade.
  recordSetupHistoryOnce({
    setupComplete: isAssistantStackSetupComplete(),
    hasProjects: listStoredHermesProjects().length > 0,
  });

  ipcMain.handle('setup:get-progress', async () => getSetupProgress());

  ipcMain.handle(
    'setup:record-outcome',
    async (_event, payload: { stepId: string; outcome: OptionalSetupOutcome }) => {
      recordOptionalStepOutcome(payload.stepId, payload.outcome);
      return getSetupProgress();
    }
  );

  ipcMain.handle('setup:pick-folders', async () => pickFirstRunFolders());

  ipcMain.handle('setup:save-folders', async (_event, payload: { folders: FirstRunFolder[] }) =>
    saveFirstRunFolders(payload.folders)
  );

  ipcMain.handle('setup:apply-folders', async () => applyFirstRunFolders());
}
