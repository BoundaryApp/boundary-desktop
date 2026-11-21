import fs from 'node:fs';
import { shell } from 'electron';
import { handle, handleResult } from '../../host/ipc';
import { broadcast } from '../../host/windows';
import { circlesDiagnosticsPath, diag } from './circlesDiagnostics';
import {
  callCheckEnabled,
  callTunnelRequest,
  listenForCalls,
  logCallEvent,
  sendCallSignal,
  listenForCallSignals,
  logCallCheckSample,
  recordCallCheckResult,
  sendCallCheckSignal,
} from './callSignals';
import { resolveNotifyLevel } from '../../../shared/circleMentions';
import { getNotifyGlobal, getNotifyPrefs, setNotifyGlobal, setNotifyPrefs } from './circlesStore';
import { exportCallCheckReport } from './callCheckReport';
import {
  addSharedFolder,
  checkFolderToShare,
  compareSharedFolderConflict,
  defaultSharedFolderRoot,
  listenForSharedFolders,
  listSharedFolders,
  removeSharedFolder,
  resolveSharedFolderConflict,
  restoreSharedFolderVersion,
  revealSharedFolder,
  scanFolderToShare,
  setSharedFolderRole,
  sharedFolderFiles,
  sharedFolderHistory,
  sharedFoldersOnMac,
  shareFolder,
} from './sharedFoldersService';
import { listenForChatSignals, sendRead, sendTyping } from './chatSignals';
import { listenForServices, servicesView, shareService, stopSharingService, stopUsingService, useService } from './servicesView';
import {
  deleteDirectMessage,
  editDirectMessage,
  getDirectMessages,
  markDirectRead,
  listDirectConversations,
  listenForDirectMessages,
  onDirectEvent,
  sendDirectMessage,
  sendDirectTyping,
} from './directService';
import {
  createCircle,
  cancelJoin,
  createCircleInvite,
  deleteCircleMessage,
  reactCircleMessage,
  editCircleMessage,
  ensureCirclesStarted,
  getCircleMessage,
  getCircleMessages,
  getCircleInviteCode,
  getCircleInviteHints,
  getCirclesState,
  circlesResult,
  getPublicAddress,
  joinCircle,
  addCircleChannel,
  listCircleChannels,
  listenForChannelChanges,
  removeCircleChannel,
  renameCircleChannel,
  markCircleChannelRead,
  circlePeople,
  setCircleViewing,
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
    postCircleMessage(input.key, input.channel, input.text, {
      ...(input.shared ? { shared: input.shared } : {}),
      picked: input.picked,
      mentionChannel: input.mentionChannel,
      ...(input.reply ? { reply: input.reply } : {}),
    })
  );
  handleResult('circles:chat-message', (_event, input) => getCircleMessage(input.key, input.channel, { author: input.author, id: input.id }));
  handleResult('circles:chat-edit', (_event, input) =>
    editCircleMessage(input.key, input.channel, input.id, input.text, {
      picked: input.picked,
      mentionChannel: input.mentionChannel,
    })
  );
  handleResult('circles:chat-delete', (_event, input) => deleteCircleMessage(input.key, input.channel, input.author, input.id));
  handleResult('circles:chat-react', (_event, input) =>
    reactCircleMessage(input.key, input.channel, { author: input.author, id: input.id }, input.emoji, input.on)
  );
  handleResult('circles:chat-read', (_event, input) => {
    const result = markCircleChannelRead(input.key, input.channel, input.position);
    if (result.success) sendRead(input.key, input.channel, input.position);
    return result;
  });
  handle('circles:chat-typing', (_event, input) => sendTyping(input.key, input.channel));
  handle('circles:notify-prefs', (_event, input) => {
    const prefs = getNotifyPrefs(input.key);
    const people = circlePeople(input.key);
    return { prefs, resolved: resolveNotifyLevel(prefs.level, people), people, global: getNotifyGlobal() };
  });
  handle('circles:set-notify-prefs', (_event, input) => setNotifyPrefs(input.key, input.prefs));
  handle('circles:set-notify-global', (_event, input) => setNotifyGlobal(input));
  handle('circles:viewing', (_event, input) => setCircleViewing(input));
  listenForChatSignals();
  listenForDirectMessages();
  onDirectEvent((event) => broadcast('circles:dm-event', event));
  handleResult('circles:dm-list', (_event, input) => listDirectConversations(input.key));
  handleResult('circles:dm-messages', (_event, input) =>
    getDirectMessages(input.key, input.peer, { before: input.before, limit: input.limit })
  );
  handleResult('circles:dm-send', (_event, input) =>
    sendDirectMessage(input.key, input.peer, input.text, input.reply ? { reply: input.reply } : {})
  );
  handleResult('circles:dm-edit', (_event, input) => editDirectMessage(input.key, input.peer, input.id, input.text));
  handleResult('circles:dm-delete', (_event, input) => deleteDirectMessage(input.key, input.peer, input.id));
  handle('circles:dm-typing', (_event, input) => sendDirectTyping(input.key, input.peer));
  handleResult('circles:dm-read', (_event, input) => markDirectRead(input.key, input.peer, input.id));
  handle('circles:call-check-enabled', () => callCheckEnabled());
  handle('circles:call-signal-send', (_event, input) => sendCallCheckSignal(input.key, input.to, input.part));
  // The address goes only to this device's renderer, and only while the check runs.
  handleResult('circles:public-address', async () =>
    callCheckEnabled()
      ? getPublicAddress()
      : { success: false as const, error: 'The call check is off.', state: getCirclesState() }
  );
  handleResult('circles:call-tunnel', (_event, input) => callTunnelRequest(input));
  handle('circles:call-check-result', (_event, input) => recordCallCheckResult(input));
  handle('circles:call-check-sample', (_event, input) => logCallCheckSample(input));
  handleResult('circles:call-check-export', (event, input) =>
    callCheckEnabled() ? exportCallCheckReport(event.sender, input) : { success: false as const, error: 'The call check is off.' }
  );
  listenForCallSignals();
  handle('circles:call-send', (_event, input) => sendCallSignal(input));
  handle('circles:call-log', (_event, input) => logCallEvent(input));
  listenForCalls();
  handleResult('circles:chat-add-channel', (_event, input) => addCircleChannel(input.key, input.name));
  handleResult('circles:chat-rename-channel', (_event, input) => renameCircleChannel(input.key, input.channel, input.name));
  handleResult('circles:chat-remove-channel', (_event, input) => removeCircleChannel(input.key, input.channel));
  listenForChannelChanges();
  handleResult('circles:folders-list', (_event, input) => listSharedFolders(input.key));
  handleResult('circles:services', () => circlesResult(async () => ({ view: await servicesView() })));
  handleResult('circles:service-share', (_event, input) => circlesResult(async () => (await shareService(input), {})));
  handleResult('circles:service-stop-sharing', (_event, input) => circlesResult(async () => (await stopSharingService(input.circle), {})));
  handleResult('circles:service-use', (_event, input) => circlesResult(() => useService(input)));
  handleResult('circles:service-stop-using', (_event, input) => circlesResult(async () => (await stopUsingService(input), {})));
  handle('circles:folder-check', (_event, input) => checkFolderToShare(input.path));
  handle('circles:folder-default-root', (_event, input) => defaultSharedFolderRoot(input.circle, input.name));
  handleResult('circles:folder-share', (_event, input) => shareFolder(input));
  handleResult('circles:folder-add', (_event, input) => addSharedFolder(input.circle, input.key, input.root));
  handleResult('circles:folder-remove', (_event, input) => removeSharedFolder(input.key, { trash: input.trash }));
  handleResult('circles:folders-on-mac', () => sharedFoldersOnMac());
  handleResult('circles:folder-history', (_event, input) => sharedFolderHistory(input.key, input.path));
  handleResult('circles:folder-restore', (_event, input) => restoreSharedFolderVersion(input.key, input.path, input.seq));
  handleResult('circles:folder-compare', (_event, input) => compareSharedFolderConflict(input.key, input.copy));
  handleResult('circles:folder-resolve', (_event, input) => resolveSharedFolderConflict(input.key, input.copy, input.keep));
  handle('circles:folder-scan', (_event, input) => scanFolderToShare(input.path));
  handleResult('circles:folder-files', (_event, input) => sharedFolderFiles(input.key));
  handleResult('circles:folder-reveal', (_event, input) => revealSharedFolder(input.key));
  handleResult('circles:folder-set-role', (_event, input) =>
    setSharedFolderRole(input.key, input.identity, input.role, input.name)
  );
  listenForSharedFolders();
  listenForServices();
  handleResult('circles:set-sharing', (_event, input) => setCircleSharingSettings(input));
  handleResult('circles:set-provider-settings', (_event, input) =>
    setProviderSettings(input.identity, { private: input.private, trusted: input.trusted })
  );
}
