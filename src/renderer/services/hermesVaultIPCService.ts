import type {
  VaultActionResult,
  VaultAddLoginPayload,
  VaultListResult,
  VaultLockPayload,
  VaultRemovePayload,
  VaultReplacePasswordPayload,
  VaultSourcesResult,
  VaultUnlockPayload,
} from '../../shared/types/hermesVault';

function api() {
  return window.electronAPI.hermesVault;
}

/** Passwords & Logins. Payloads with a password must never be logged. */
export const hermesVaultIPC = {
  listLogins(agentSlug: string): Promise<VaultListResult> {
    return api().listLogins({ agentSlug });
  },

  listSources(agentSlug: string): Promise<VaultSourcesResult> {
    return api().listSources({ agentSlug });
  },

  addLogin(payload: VaultAddLoginPayload): Promise<VaultActionResult> {
    return api().addLogin(payload);
  },

  replacePassword(payload: VaultReplacePasswordPayload): Promise<VaultActionResult> {
    return api().replacePassword(payload);
  },

  removeLogin(payload: VaultRemovePayload): Promise<VaultActionResult> {
    return api().removeLogin(payload);
  },

  unlockSource(payload: VaultUnlockPayload): Promise<VaultActionResult> {
    return api().unlockSource(payload);
  },

  lockSource(payload: VaultLockPayload): Promise<VaultActionResult> {
    return api().lockSource(payload);
  },
};
