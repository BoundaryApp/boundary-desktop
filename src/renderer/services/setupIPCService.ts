import type {
  ApplyFirstRunFoldersResult,
  FirstRunFolder,
  OptionalSetupOutcome,
  PickFirstRunFoldersResult,
  SaveFirstRunFoldersResult,
  SetupProgress,
} from '../../shared/types/setupProgress';

export const setupIPC = {
  getProgress(): Promise<SetupProgress> {
    return window.electronAPI.setup.getProgress();
  },

  recordOutcome(stepId: string, outcome: OptionalSetupOutcome): Promise<SetupProgress> {
    return window.electronAPI.setup.recordOutcome({ stepId, outcome });
  },

  pickFolders(): Promise<PickFirstRunFoldersResult> {
    return window.electronAPI.setup.pickFolders();
  },

  saveFolders(folders: FirstRunFolder[]): Promise<SaveFirstRunFoldersResult> {
    return window.electronAPI.setup.saveFolders({ folders });
  },

  applyFolders(): Promise<ApplyFirstRunFoldersResult> {
    return window.electronAPI.setup.applyFolders();
  },
};
