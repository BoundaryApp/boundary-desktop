import { handle, handleResult } from '../../../ipc';
import type {
  CodingCreateFolderPayload,
  CodingDeleteFolderPayload,
  CodingGrantPayload,
  CodingProjectFolderPayload,
  CodingRemoveFolderPayload,
  CodingRevokePayload,
} from '../../../../shared/types/codingFolders';
import {
  checkNewCodingFolder,
  codingFoldersBusy,
  createCodingFolder,
  grantCoding,
  inspectCodingFolder,
  listCodingGrants,
  newCodingFolderDefaults,
  pickCodingFolder,
  pickCodingParent,
  restartHermesForCodingGrants,
  retryCodingMounts,
  revokeCoding,
  setProjectFolderCoding,
  verifyCodingGrants,
} from './codingGrants';
import {
  deleteCodingFolder,
  inspectFolderForDelete,
  removeCodingFolder,
  showTrash,
} from './codingFolderActions';

/** Coding folders (ADR 0028). */
export function registerCodingFolderHandlers(): void {
  handleResult('coding-folders:list', async () => listCodingGrants());
  handle('coding-folders:busy', async () => codingFoldersBusy());
  handleResult('coding-folders:grant', async (_event, payload: CodingGrantPayload) =>
    grantCoding(payload)
  );
  handleResult(
    'coding-folders:project-folder',
    async (_event, payload: CodingProjectFolderPayload) => setProjectFolderCoding(payload)
  );
  handleResult('coding-folders:revoke', async (_event, payload: CodingRevokePayload) =>
    revokeCoding(payload)
  );
  handleResult(
    'coding-folders:create-folder',
    async (_event, payload: CodingCreateFolderPayload) => createCodingFolder(payload)
  );
  handleResult('coding-folders:restart-hermes', async () => restartHermesForCodingGrants());
  handleResult('coding-folders:retry', async () => retryCodingMounts());
  handleResult('coding-folders:pick', async () => pickCodingFolder());
  handleResult('coding-folders:verify', async (_event, payload?: { force?: boolean }) =>
    verifyCodingGrants(payload?.force)
  );
  handleResult(
    'coding-folders:remove',
    async (_event, payload: CodingRemoveFolderPayload) => removeCodingFolder(payload)
  );
  handleResult('coding-folders:inspect-delete', async (_event, payload: { hostPath: string }) =>
    inspectFolderForDelete(payload.hostPath)
  );
  handleResult(
    'coding-folders:delete',
    async (_event, payload: CodingDeleteFolderPayload) => deleteCodingFolder(payload)
  );
  handle('coding-folders:show-trash', async () => showTrash());
  handle('coding-folders:new-folder-defaults', async () => newCodingFolderDefaults());
  handleResult(
    'coding-folders:check-new-folder',
    async (_event, payload: { parent: string; name: string }) => checkNewCodingFolder(payload)
  );
  handleResult('coding-folders:pick-parent', async (_event, payload?: { defaultPath?: string }) =>
    pickCodingParent(payload?.defaultPath)
  );
  handleResult('coding-folders:inspect-folder', async (_event, payload: { hostPath: string }) =>
    inspectCodingFolder(payload.hostPath)
  );
}
