import fs from 'node:fs';
import { shell } from 'electron';
import { handle, handleResult } from '../../ipc';
import { circlesDiagnosticsPath, diag } from './circlesDiagnostics';
import {
  createCircle,
  cancelJoin,
  createCircleInvite,
  ensureCirclesStarted,
  getCircleInviteCode,
  getCircleInviteHints,
  getCirclesState,
  joinCircle,
  deleteCircle,
  leaveCircle,
  removeCircleMember,
  revokeCircleInvite,
  setCircleRole,
  setCircleSharingSettings,
  setDisplayName,
  setProviderSettings,
} from './circlesService';

export function registerCirclesHandlers(): void {
  handle('circles:get-state', () => getCirclesState());
  handleResult('circles:start', async () => {
    try {
      await ensureCirclesStarted();
      return { success: true, state: getCirclesState() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), state: getCirclesState() };
    }
  });
  handleResult('circles:set-display-name', (_event, input) => setDisplayName(input.name));
  handleResult('circles:create', (_event, input) => createCircle(input.name));
  handleResult('circles:join', (_event, input) => joinCircle(input.code));
  handleResult('circles:cancel-join', () => cancelJoin());
  handleResult('circles:create-invite', (_event, input) => createCircleInvite(input.key, input.expiresInMs, input.label));
  handleResult('circles:revoke-invite', (_event, input) => revokeCircleInvite(input.key, input.inviteId));
  handleResult('circles:invite-hints', (_event, input) => getCircleInviteHints(input.key));
  handleResult('circles:invite-code', (_event, input) => getCircleInviteCode(input.key, input.inviteId));
  handleResult('circles:set-role', (_event, input) => setCircleRole(input.key, input.identity, input.role));
  handleResult('circles:remove-member', (_event, input) => removeCircleMember(input.key, input.identity));
  handleResult('circles:leave', (_event, input) => leaveCircle(input.key));
  handleResult('circles:delete', (_event, input) => deleteCircle(input.key));
  handleResult('circles:reveal-diagnostics', () => {
    const file = circlesDiagnosticsPath();
    // Writing a line first makes sure the file exists to be shown.
    diag('main.diagnostics-revealed', {});
    if (!fs.existsSync(file)) return { success: false, error: 'There’s no diagnostics file yet.' };
    shell.showItemInFolder(file);
    return { success: true };
  });
  handleResult('circles:set-sharing', (_event, input) => setCircleSharingSettings(input));
  handleResult('circles:set-provider-settings', (_event, input) =>
    setProviderSettings(input.identity, { private: input.private, trusted: input.trusted })
  );
}
