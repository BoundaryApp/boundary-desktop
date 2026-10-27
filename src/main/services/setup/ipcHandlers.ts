import { handle, handleResult } from '../../ipc';
import type { FirstRunFolder, OptionalSetupOutcome } from '../../../shared/types/setupProgress';
import { getSetupProgress, recordOptionalStepOutcome } from './SetupProgressStore';
import { applyFirstRunFolders, pickFirstRunFolders, saveFirstRunFolders } from './firstRunFolders';

export function registerSetupHandlers(): void {
  handle('setup:get-progress', async () => getSetupProgress());

  handle(
    'setup:record-outcome',
    async (_event, payload: { stepId: string; outcome: OptionalSetupOutcome }) => {
      recordOptionalStepOutcome(payload.stepId, payload.outcome);
      return getSetupProgress();
    }
  );

  handle('setup:pick-folders', async () => pickFirstRunFolders());

  handleResult('setup:save-folders', async (_event, payload: { folders: FirstRunFolder[] }) =>
    saveFirstRunFolders(payload.folders)
  );

  handleResult('setup:apply-folders', async () => applyFirstRunFolders());
}
