import { handleResult } from '../../../ipc';
import type {
  HermesChannelAddMemberPayload,
  HermesChannelCreatePayload,
  HermesChannelDeletePayload,
  HermesChannelRenamePayload,
  HermesMakeChannelFromChatPayload,
  HermesSetLastOpenedPayload,
} from '../../../../shared/types/hermesChat';
import {
  addHermesChannelMember,
  createHermesChannel,
  deleteHermesChannel,
  listHermesChannels,
  makeChannelFromHermesChat,
  removeHermesChannelMember,
  renameHermesChannel,
  setHermesLastOpened,
} from './hermesChannels';
import { fileChannels } from './hermesChatProjects';

export function registerChannelHandlers(): void {
  handleResult('hermes-channels:list', async () => {
    const result = listHermesChannels();
    return result.success ? { ...result, channels: fileChannels(result.channels) } : result;
  });

  handleResult('hermes-channels:create', async (_event, payload: HermesChannelCreatePayload) =>
    createHermesChannel(payload)
  );

  handleResult('hermes-channels:add-member', async (_event, payload: HermesChannelAddMemberPayload) =>
    addHermesChannelMember(payload)
  );

  handleResult('hermes-channels:remove-member', async (_event, payload: HermesChannelAddMemberPayload) =>
    removeHermesChannelMember(payload)
  );

  handleResult('hermes-channels:rename', async (_event, payload: HermesChannelRenamePayload) =>
    renameHermesChannel(payload)
  );

  handleResult('hermes-channels:delete', async (_event, payload: HermesChannelDeletePayload) =>
    deleteHermesChannel(payload)
  );

  handleResult(
    'hermes-channels:make-from-chat',
    async (_event, payload: HermesMakeChannelFromChatPayload) => makeChannelFromHermesChat(payload)
  );

  handleResult('hermes-channels:set-last-opened', async (_event, payload: HermesSetLastOpenedPayload) =>
    setHermesLastOpened(payload)
  );
}
