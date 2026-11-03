import fs from 'node:fs';
import { shell } from 'electron';
import { handle, handleResult } from '../../ipc';
import { circlesDiagnosticsPath, diag } from './circlesDiagnostics';
import { callCheckEnabled, listenForCallSignals, logCallCheckResult, sendCallCheckSignal } from './callSignals';
import { listenForChatSignals, sendRead, sendTyping } from './chatSignals';
import {
  createCircle,
  cancelJoin,
  createCircleInvite,
  deleteCircleMessage,
  editCircleMessage,
  ensureCirclesStarted,
  getCircleMessages,
  getCircleInviteCode,
  getCircleInviteHints,
  getCirclesState,
  getPublicAddress,
  joinCircle,
  addCircleChannel,
  listCircleChannels,
  listenForChannelChanges,
  removeCircleChannel,
  renameCircleChannel,
  markCircleChannelRead,
  postCircleMessage,
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
  handleResult('circles:chat-channels', (_event, input) => listCircleChannels(input.key));
  handleResult('circles:chat-messages', (_event, input) =>
    getCircleMessages(input.key, input.channel, { before: input.before, limit: input.limit })
  );
  handleResult('circles:chat-post', (_event, input) =>
    postCircleMessage(input.key, input.channel, input.text, input.shared ? { shared: input.shared } : {})
  );
  handleResult('circles:chat-edit', (_event, input) => editCircleMessage(input.key, input.channel, input.id, input.text));
  handleResult('circles:chat-delete', (_event, input) => deleteCircleMessage(input.key, input.channel, input.author, input.id));
  handleResult('circles:chat-read', (_event, input) => {
    const result = markCircleChannelRead(input.key, input.channel, input.position);
    if (result.success) sendRead(input.key, input.channel, input.position);
    return result;
  });
  handle('circles:chat-typing', (_event, input) => sendTyping(input.key, input.channel));
  listenForChatSignals();
  handle('circles:call-check-enabled', () => callCheckEnabled());
  handle('circles:call-signal-send', (_event, input) => sendCallCheckSignal(input.key, input.to, input.part));
  // The address goes only to this device's renderer, and only while the check runs.
  handleResult('circles:public-address', async () =>
    callCheckEnabled()
      ? getPublicAddress()
      : { success: false as const, error: 'The call check is off.', state: getCirclesState() }
  );
  handle('circles:call-check-result', (_event, input) => logCallCheckResult(input));
  listenForCallSignals();
  handleResult('circles:chat-add-channel', (_event, input) => addCircleChannel(input.key, input.name));
  handleResult('circles:chat-rename-channel', (_event, input) => renameCircleChannel(input.key, input.channel, input.name));
  handleResult('circles:chat-remove-channel', (_event, input) => removeCircleChannel(input.key, input.channel));
  listenForChannelChanges();
  handleResult('circles:set-sharing', (_event, input) => setCircleSharingSettings(input));
  handleResult('circles:set-provider-settings', (_event, input) =>
    setProviderSettings(input.identity, { private: input.private, trusted: input.trusted })
  );
}
