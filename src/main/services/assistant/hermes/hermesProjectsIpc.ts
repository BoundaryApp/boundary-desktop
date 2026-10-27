import { handle, handleResult } from '../../../ipc';
import type {
  HermesCompletePathPayload,
  HermesProjectChangeFolderPayload,
  HermesProjectCreateEmptyPayload,
  HermesProjectCreateHostPayload,
  HermesProjectPatchPayload,
  HermesProjectSelectPayload,
  HermesProjectSourcesAddPayload,
  HermesProjectSourcesInspectPayload,
  HermesProjectSourcesRemovePayload,
  HermesProjectSourcesRevealPayload,
} from '../../../../shared/types/hermesChat';
import {
  changeHermesProjectFolder,
  completeHermesPath,
  createEmptyHermesProject,
  createHostFolderHermesProject,
  listHermesProjects,
  patchHermesProject,
  pickHermesProjectFolder,
  revealHermesProjectInFinder,
  selectHermesProject,
} from './hermesProjects';
import {
  addHermesProjectSourceFolder,
  countHermesProjectExtraSources,
  inspectHermesProjectSources,
  refreshHermesProjectIndex,
  removeHermesProjectSource,
  revealHermesProjectSource,
} from './hermesProjectSources';

/** Projects and their source folders. */
export function registerProjectHandlers(): void {
  handleResult('hermes-projects:list', async () => listHermesProjects());

  handleResult('hermes-projects:pick-folder', async () => pickHermesProjectFolder());

  handleResult('hermes-projects:create-host', async (_event, payload: HermesProjectCreateHostPayload) =>
    createHostFolderHermesProject(payload)
  );

  handleResult('hermes-projects:create-empty', async (_event, payload: HermesProjectCreateEmptyPayload) =>
    createEmptyHermesProject(payload)
  );

  handleResult('hermes-projects:select', async (_event, payload: HermesProjectSelectPayload) =>
    selectHermesProject(payload)
  );

  handleResult(
    'hermes-projects:change-folder',
    async (_event, payload: HermesProjectChangeFolderPayload) => changeHermesProjectFolder(payload)
  );

  handleResult('hermes-projects:patch', async (_event, payload: HermesProjectPatchPayload) =>
    patchHermesProject(payload)
  );

  handleResult('hermes-projects:reveal', async (_event, payload: { projectId: string }) =>
    revealHermesProjectInFinder(payload.projectId)
  );

  handleResult('hermes-projects:complete-path', async (_event, payload: HermesCompletePathPayload) =>
    completeHermesPath(payload)
  );

  handle('hermes-projects:source-count', async (_event, payload: { projectId: string }) =>
    countHermesProjectExtraSources(payload.projectId)
  );

  handleResult(
    'hermes-projects:sources-inspect',
    async (_event, payload: HermesProjectSourcesInspectPayload) =>
      inspectHermesProjectSources(payload.projectId)
  );

  handleResult('hermes-projects:sources-add', async (_event, payload: HermesProjectSourcesAddPayload) =>
    addHermesProjectSourceFolder(payload.projectId, payload.hostPath)
  );

  handleResult(
    'hermes-projects:sources-remove',
    async (_event, payload: HermesProjectSourcesRemovePayload) =>
      removeHermesProjectSource(payload.projectId, payload.sourceId)
  );

  handleResult(
    'hermes-projects:sources-reveal',
    async (_event, payload: HermesProjectSourcesRevealPayload) =>
      revealHermesProjectSource(payload.projectId, payload.sourceId)
  );

  handleResult(
    'hermes-projects:sources-refresh',
    async (_event, payload: HermesProjectSourcesInspectPayload) =>
      refreshHermesProjectIndex(payload.projectId)
  );
}
