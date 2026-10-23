import { ipcMain } from 'electron';
import type {
  VaultAddLoginPayload,
  VaultLockPayload,
  VaultRemovePayload,
  VaultReplacePasswordPayload,
  VaultUnlockPayload,
} from '../../../../shared/types/hermesVault';
import {
  addVaultLogin,
  listVaultLogins,
  listVaultSources,
  lockVaultSource,
  removeVaultLogin,
  replaceVaultLoginPassword,
  unlockVaultSource,
} from './hermesVault';

export function registerHermesVaultHandlers(): void {
  ipcMain.handle('hermes-vault:list', async (_event, payload: { agentSlug: string }) =>
    listVaultLogins(payload)
  );

  ipcMain.handle('hermes-vault:sources', async (_event, payload: { agentSlug: string }) =>
    listVaultSources(payload)
  );

  // Carries a password: no logging here or downstream.
  ipcMain.handle('hermes-vault:add-login', async (_event, payload: VaultAddLoginPayload) =>
    addVaultLogin(payload)
  );

  // Carries a password: no logging here or downstream.
  ipcMain.handle(
    'hermes-vault:replace-password',
    async (_event, payload: VaultReplacePasswordPayload) => replaceVaultLoginPassword(payload)
  );

  ipcMain.handle('hermes-vault:remove', async (_event, payload: VaultRemovePayload) =>
    removeVaultLogin(payload)
  );

  // Carries a master password: no logging here or downstream.
  ipcMain.handle('hermes-vault:unlock', async (_event, payload: VaultUnlockPayload) =>
    unlockVaultSource(payload)
  );

  ipcMain.handle('hermes-vault:lock', async (_event, payload: VaultLockPayload) =>
    lockVaultSource(payload)
  );
}
