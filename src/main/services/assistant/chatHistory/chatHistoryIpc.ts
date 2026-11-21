import { app, dialog, shell } from 'electron';
import { BUILTIN_ASSISTANT_SLUG } from '../../../../shared/types/hermesChat';
import { handle, handleResult } from '../../../ipc';
import { persistDebugLog } from '../../../persistDebugLog';
import { dialogStartFolder, rememberDialogPick } from '../../dialogFolders';
import { getStackFiles } from '../../stackHost/activeStack';
import { hasStackCapability } from '../../stackHost/capabilities';
import { broadcast } from '../../windows';
import { getAssistantStackAccess } from '../AssistantStackService';
import { stackMode } from '../localStackMode';
import { listStoredAgents, readHermesAgentStoreSnapshot } from '../hermes/hermesAgentStore';
import { listStoredHermesProjects } from '../hermes/hermesProjectStore';
import { listWritingVoiceRecords } from '../writingVoices/writingVoiceStore';
import { DEFAULT_PROFILE } from './boundaryHistory';
import { createChatHistoryMover } from './chatHistoryExport';

/** ADR 0070 §13: the export folder would be on the other computer. */
const CHAT_HISTORY_REMOTE_TEXT =
  'Your agent runs on another computer, so chat history can’t be exported or imported from here yet.';

const mover = createChatHistoryMover({
  commands: () => getAssistantStackAccess(),
  files: getStackFiles,
  readStore: readHermesAgentStoreSnapshot,
  listProjects: listStoredHermesProjects,
  listWritingVoices: listWritingVoiceRecords,
  profileLabel: (profile) => {
    const slug = profile === DEFAULT_PROFILE ? BUILTIN_ASSISTANT_SLUG : profile;
    return listStoredAgents().find((a) => a.slug === slug)?.displayName ?? null;
  },
  appVersion: () => app.getVersion(),
  source: () => ({ stack: stackMode().kind }),
  // Only a host on another computer lacks host folders (ADR 0062 §4).
  unavailable: () => (hasStackCapability('hostFolders') ? null : CHAT_HISTORY_REMOTE_TEXT),
  now: () => new Date(),
  log: (message, data) => persistDebugLog('history-move', message, data),
  onChange: (state) => broadcast('chat-history:changed', state),
});

export function registerChatHistoryHandlers(): void {
  handle('chat-history:status', async () => mover.status());
  handleResult('chat-history:export', async () => {
    const refused = mover.status().unavailable;
    if (refused) return { success: false as const, error: refused };
    if (mover.status().state.phase === 'exporting') {
      return { success: false as const, error: 'A history export is already running.' };
    }
    const picked = await dialog.showOpenDialog({
      title: 'Choose where to save chat history',
      buttonLabel: 'Export here',
      message: 'Boundary makes a new folder here holding your chats.',
      defaultPath: dialogStartFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    const parent = picked.filePaths[0];
    if (picked.canceled || !parent) return { success: true as const, started: false };
    rememberDialogPick(parent);
    void mover.exportTo(parent);
    return { success: true as const, started: true };
  });
  handle('chat-history:cancel', async () => mover.cancel());
  handleResult('chat-history:reveal', async (_event, folder: string) => {
    const state = mover.status().state;
    // Only the folder this export made, never a path the renderer names.
    if (state.phase !== 'exported' || state.folder !== folder) return { success: false, error: 'That folder isn’t the last export.' };
    shell.showItemInFolder(folder);
    return { success: true };
  });
}
