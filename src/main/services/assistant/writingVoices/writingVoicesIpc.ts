import fs from 'node:fs';
import path from 'node:path';
import { dialog, shell } from 'electron';
import type {
  WritingVoiceActionResult,
  WritingVoiceCreatePayload,
  WritingVoicePickResult,
  WritingVoiceSource,
} from '../../../../shared/types/writingVoices';
import { handle, handleResult } from '../../../ipc';
import { dialogStartFolder, rememberDialogPick } from '../../dialogFolders';
import { broadcast } from '../../windows';
import { calibrateWritingVoice, isWritingVoiceCalibrating } from './writingVoiceCalibration';
import { writingVoiceDir } from './writingVoicePaths';
import {
  addWritingVoiceSamples,
  createWritingVoice,
  deleteWritingVoice,
  listWritingVoiceSamples,
  listWritingVoiceViews,
  removeWritingVoiceSample,
  renameWritingVoice,
  setWritingVoiceNeverDoes,
} from './writingVoices';
import { checkWritingVoiceSamples, WRITING_VOICE_SAMPLE_EXTENSIONS } from './writingVoiceSamples';
import { listWritingVoiceRecords } from './writingVoiceStore';
import {
  clearWritingVoiceFromAgents,
  clearWritingVoiceFromChats,
  getChatWritingVoice,
  setChatWritingVoice,
  writingVoiceUsers,
} from './agentWritingVoices';
import {
  getStoredAgent,
  listSessionsKeepingWritingVoice,
  moveSessionWritingVoice,
} from '../hermes/hermesAgentStore';
import { durableSessionId } from '../hermes/hermesAgents';
import { withBuiltinAgentName } from '../hermes/builtinAgentName';

/** The create sheet's **Choose files…**: text types first, any file allowed so it can say why not. */
export async function pickWritingVoiceSamples(): Promise<WritingVoicePickResult> {
  const picked = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    title: 'Add writing samples',
    defaultPath: dialogStartFolder(),
    filters: [
      { name: 'Writing', extensions: WRITING_VOICE_SAMPLE_EXTENSIONS.map((e) => e.slice(1)) },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
  rememberDialogPick(picked.filePaths[0]);
  return { canceled: false, paths: picked.filePaths };
}

/** Start a calibration without waiting for it; progress goes to every window. */
function startCalibration(id: string): WritingVoiceActionResult {
  if (!listWritingVoiceRecords().some((v) => v.id === id)) {
    return { success: false, error: 'No such voice.' };
  }
  if (isWritingVoiceCalibrating(id)) return { success: true };
  void calibrateWritingVoice(id, {
    onProgress: (progress) => broadcast('writing-voices:progress', progress),
  });
  return { success: true };
}

function openInFinder(id: string, file?: string): WritingVoiceActionResult {
  const dir = writingVoiceDir(id);
  const target = file ? path.join(dir, file) : dir;
  if (!fs.existsSync(target)) return { success: false, error: 'That file is not there any more.' };
  if (file) void shell.openPath(target);
  else shell.showItemInFolder(target);
  return { success: true };
}

/** Every window reloads its voices: one was created, deleted, renamed or edited. */
function voicesChanged<T>(result: T): T {
  broadcast('writing-voices:changed');
  return result;
}

/** The id a chat's kept voice lives under: the stored one, which outlasts a stack restart. */
function chatVoiceKey(sessionId: string): string {
  const storedId = durableSessionId(sessionId);
  moveSessionWritingVoice(sessionId, storedId);
  return storedId;
}

export function registerWritingVoiceHandlers(): void {
  handleResult('writing-voices:list', async () => ({
    success: true as const,
    voices: await listWritingVoiceViews(),
  }));
  handle('writing-voices:check', async (_event, sources: WritingVoiceSource[]) =>
    checkWritingVoiceSamples(sources)
  );
  handle('writing-voices:pick', async () => pickWritingVoiceSamples());
  handleResult('writing-voices:create', async (_event, payload: WritingVoiceCreatePayload) => {
    const result = await createWritingVoice(payload);
    if ('voice' in result) {
      startCalibration(result.voice.id);
      broadcast('writing-voices:changed');
    }
    return result;
  });
  handleResult('writing-voices:calibrate', async (_event, id: string) => startCalibration(id));
  handleResult('writing-voices:samples', async (_event, id: string) => listWritingVoiceSamples(id));
  handleResult('writing-voices:add-samples', async (_event, id: string, sources: WritingVoiceSource[]) =>
    voicesChanged(await addWritingVoiceSamples(id, sources))
  );
  handleResult('writing-voices:remove-sample', async (_event, id: string, name: string) =>
    voicesChanged(await removeWritingVoiceSample(id, name))
  );
  handleResult('writing-voices:never-does', async (_event, id: string, lines: string[]) =>
    voicesChanged(await setWritingVoiceNeverDoes(id, lines))
  );
  handleResult('writing-voices:rename', async (_event, id: string, name: string) =>
    voicesChanged(await renameWritingVoice(id, name))
  );
  handleResult('writing-voices:delete', async (_event, id: string) => {
    const result = await deleteWritingVoice(id, { trash: (folder) => shell.trashItem(folder) });
    if (result.success) {
      clearWritingVoiceFromAgents(id);
      clearWritingVoiceFromChats(id);
      broadcast('writing-voices:changed');
    }
    return result;
  });
  handleResult('writing-voices:chat-get', async (_event, sessionId: string) => ({
    success: true as const,
    voice: await getChatWritingVoice(chatVoiceKey(sessionId)),
  }));
  handleResult('writing-voices:chat-set', async (_event, sessionId: string, voiceId: string | null) =>
    setChatWritingVoice(chatVoiceKey(sessionId), voiceId)
  );
  handleResult('writing-voices:users', async (_event, id: string) => ({
    success: true as const,
    chats: listSessionsKeepingWritingVoice(id).length,
    agents: writingVoiceUsers(id).map((user) => {
      const stored = getStoredAgent(user.slug);
      return stored ? { ...user, displayName: withBuiltinAgentName(stored).displayName } : user;
    }),
  }));
  handleResult('writing-voices:open-style', async (_event, id: string) => openInFinder(id, 'STYLE.md'));
  handleResult('writing-voices:reveal', async (_event, id: string) => openInFinder(id));
}
