import { contextBridge, ipcRenderer } from 'electron';
import { Task } from './shared/types/task';
import { createFileLogger } from './shared/utils/logger';
import './preloadLagProbe';

const log = createFileLogger(undefined, 'preload');

// Previous builds forced localStorage.debug='*', which flooded the DevTools
// console and retained unbounded log memory. Clear that default once.
if (typeof localStorage !== 'undefined' && localStorage.getItem('debug') === '*') {
  localStorage.removeItem('debug');
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
log('Preload script executing, exposing electronAPI...');

contextBridge.exposeInMainWorld('electronAPI', {
  appearance: {
    getTheme: () => ipcRenderer.invoke('appearance:get-theme'),
    setTheme: (preference: import('./shared/theme').ThemePreference) =>
      ipcRenderer.invoke('appearance:set-theme', preference),
  },
  appMenu: {
    onCommand: (callback: (command: import('./shared/appCommands').AppCommand) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: import('./shared/appCommands').AppCommand) =>
        callback(command);
      ipcRenderer.on('app:menu-command', handler);
      return () => ipcRenderer.removeListener('app:menu-command', handler);
    },
  },
  onboarding: {
    getStatus: () => ipcRenderer.invoke('onboarding:get-status'),
    listProviders: () => ipcRenderer.invoke('onboarding:list-providers'),
    discoverProviderEndpoints: (
      input: import('./shared/types/onboarding').DiscoverProviderEndpointsInput
    ) => ipcRenderer.invoke('onboarding:discover-provider-endpoints', input),
    listProviderDeployments: (
      input: import('./shared/types/onboarding').ListProviderDeploymentsInput
    ) => ipcRenderer.invoke('onboarding:list-provider-deployments', input),
    listDeployableModels: (
      input: import('./shared/types/onboarding').ListDeployableModelsInput
    ) => ipcRenderer.invoke('onboarding:list-deployable-models', input),
    adoptProviderEndpoint: (input: import('./shared/types/onboarding').AdoptProviderEndpointInput) =>
      ipcRenderer.invoke('onboarding:adopt-provider-endpoint', input),
    startProviderSetup: (input: import('./shared/types/onboarding').StartProviderSetupInput) =>
      ipcRenderer.invoke('onboarding:start-provider-setup', input),
    saveOpenAiConfig: (input: import('./shared/types/onboarding').SaveOpenAiConfigInput) =>
      ipcRenderer.invoke('onboarding:save-openai-config', input),
    clearOpenAiConfig: (input?: import('./shared/types/onboarding').ClearLlmSlotInput) =>
      ipcRenderer.invoke('onboarding:clear-openai-config', input),
    clearLlmSlot: (input: import('./shared/types/onboarding').ClearLlmSlotInput) =>
      ipcRenderer.invoke('onboarding:clear-llm-slot', input),
    setAppDefault: (input: import('./shared/types/onboarding').SetAppDefaultInput) =>
      ipcRenderer.invoke('onboarding:set-app-default', input),
    probeSlotHealth: (input: import('./shared/types/onboarding').ProbeSlotHealthInput) =>
      ipcRenderer.invoke('onboarding:probe-slot-health', input),
    clearPendingProviderSetup: () => ipcRenderer.invoke('onboarding:clear-pending-provider-setup'),
    getProviderFormDraft: (input: import('./shared/types/onboarding').GetProviderFormDraftInput) =>
      ipcRenderer.invoke('onboarding:get-provider-form-draft', input),
    saveProviderFormDraft: (input: import('./shared/types/onboarding').SaveProviderFormDraftInput) =>
      ipcRenderer.invoke('onboarding:save-provider-form-draft', input),
    clearProviderFormDraft: (input?: import('./shared/types/onboarding').ClearProviderFormDraftInput) =>
      ipcRenderer.invoke('onboarding:clear-provider-form-draft', input),
    discoverLocalLlms: () => ipcRenderer.invoke('onboarding:discover-local-llms'),
    adoptLocalLlm: (input: import('./shared/types/onboarding').AdoptLocalLlmInput) =>
      ipcRenderer.invoke('onboarding:adopt-local-llm', input),
    dismissLocalLlm: (input: import('./shared/types/onboarding').DismissLocalLlmInput) =>
      ipcRenderer.invoke('onboarding:dismiss-local-llm', input),
    listOAuthProviders: () => ipcRenderer.invoke('onboarding:list-oauth-providers'),
    startOAuthPkce: (input: import('./shared/types/onboarding').StartOAuthPkceInput) =>
      ipcRenderer.invoke('onboarding:start-oauth-pkce', input),
    cancelOAuthPkce: () => ipcRenderer.invoke('onboarding:cancel-oauth-pkce'),
    listEndpointModels: (input: import('./shared/types/onboarding').ListEndpointModelsInput) =>
      ipcRenderer.invoke('onboarding:list-endpoint-models', input),
    listConfiguredEndpointModels: (
      input?: import('./shared/types/onboarding').ListConfiguredEndpointModelsInput
    ) => ipcRenderer.invoke('onboarding:list-configured-endpoint-models', input),
    saveLlmConnection: (input: import('./shared/types/onboarding').SaveLlmConnectionInput) =>
      ipcRenderer.invoke('onboarding:save-llm-connection', input),
    updateLlmModel: (input: import('./shared/types/onboarding').UpdateLlmModelInput) =>
      ipcRenderer.invoke('onboarding:update-llm-model', input),
    sendLlmTestMessage: (input: import('./shared/types/onboarding').SendLlmTestMessageInput) =>
      ipcRenderer.invoke('onboarding:send-llm-test-message', input),
    onLocalLlmChanged: (
      callback: (payload: import('./shared/types/onboarding').LocalLlmChangedPayload) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: import('./shared/types/onboarding').LocalLlmChangedPayload
      ) => {
        callback(payload);
      };
      ipcRenderer.on('local-llm:changed', listener);
      return () => {
        ipcRenderer.removeListener('local-llm:changed', listener);
      };
    },
  },
  capability: {
    assess: () => ipcRenderer.invoke('capability:assess'),
    getStatus: () => ipcRenderer.invoke('capability:get-status'),
    acknowledge: () => ipcRenderer.invoke('capability:acknowledge'),
    getRuntimeDiagnostics: (
      input?: import('./shared/types/containerRuntimeDiagnostics').GetRuntimeDiagnosticsInput
    ) => ipcRenderer.invoke('capability:get-runtime-diagnostics', input),
    getDebugLog: () => ipcRenderer.invoke('capability:get-debug-log'),
    onProgress: (callback: (message: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string) => {
        callback(message);
      };
      ipcRenderer.on('capability:progress', listener);
      return () => {
        ipcRenderer.removeListener('capability:progress', listener);
      };
    },
  },
  assistantStack: {
    getStatus: () => ipcRenderer.invoke('assistant-stack:get-status'),
    getLifecycle: () => ipcRenderer.invoke('assistant-stack:get-lifecycle'),
    ensureRunning: () => ipcRenderer.invoke('assistant-stack:ensure-running'),
    ensureRunningInBackground: () =>
      ipcRenderer.invoke('assistant-stack:ensure-running-background'),
    ensureAndApplyLlm: () => ipcRenderer.invoke('assistant-stack:ensure-and-apply-llm'),
    applyLlm: (payload?: import('./shared/types/assistantStack').ApplyAssistantLlmPayload) =>
      ipcRenderer.invoke('assistant-stack:apply-llm', payload),
    stop: () => ipcRenderer.invoke('assistant-stack:stop'),
    resetInstall: () => ipcRenderer.invoke('assistant-stack:reset-install'),
    onProgress: (callback: (message: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, message: string) => {
        callback(message);
      };
      ipcRenderer.on('assistant-stack:progress', listener);
      return () => {
        ipcRenderer.removeListener('assistant-stack:progress', listener);
      };
    },
    onLifecycle: (
      callback: (snapshot: import('./shared/types/assistantStack').AssistantStackLifecycleSnapshot) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: import('./shared/types/assistantStack').AssistantStackLifecycleSnapshot
      ) => {
        callback(snapshot);
      };
      ipcRenderer.on('assistant-stack:lifecycle', listener);
      return () => {
        ipcRenderer.removeListener('assistant-stack:lifecycle', listener);
      };
    },
  },
  resources: {
    getSnapshot: () => ipcRenderer.invoke('resources:get-snapshot'),
    getComposeInventory: () => ipcRenderer.invoke('resources:get-compose-inventory'),
    subscribeComposeInventory: (
      callback: (snapshot: import('./shared/types/composeInventory').ComposeInventorySnapshot) => void
    ) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        snapshot: import('./shared/types/composeInventory').ComposeInventorySnapshot
      ) => {
        callback(snapshot);
      };
      ipcRenderer.on('resources:compose-inventory', listener);
      void ipcRenderer.invoke('resources:subscribe-compose-inventory');
      return () => {
        ipcRenderer.removeListener('resources:compose-inventory', listener);
        void ipcRenderer.invoke('resources:unsubscribe-compose-inventory');
      };
    },
  },
  hostBridge: {
    onApproval: (
      callback: (event: import('./shared/types/hostBridge').HostBridgeApprovalEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hostBridge').HostBridgeApprovalEvent);
      ipcRenderer.on('host-bridge:approval', handler);
      return () => ipcRenderer.removeListener('host-bridge:approval', handler);
    },
    onApprovalCleared: (callback: (event: { id: string }) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as { id: string });
      ipcRenderer.on('host-bridge:approval-cleared', handler);
      return () => ipcRenderer.removeListener('host-bridge:approval-cleared', handler);
    },
    respondApproval: (payload: import('./shared/types/hostBridge').HostBridgeApprovalRespondPayload) =>
      ipcRenderer.invoke('host-bridge:approval-respond', payload),
    listPendingApprovals: () => ipcRenderer.invoke('host-bridge:approvals-pending'),
    getToolsState: () => ipcRenderer.invoke('host-bridge:tools-state'),
    onToolsState: (callback: (state: import('./shared/types/hostBridge').HostToolsState) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hostBridge').HostToolsState);
      ipcRenderer.on('host-bridge:tools-state', handler);
      return () => ipcRenderer.removeListener('host-bridge:tools-state', handler);
    },
    getBrowserState: () => ipcRenderer.invoke('host-bridge:browser-state'),
    updateBrowserSettings: (settings: import('./shared/types/hostBridge').HostBridgeBrowserSettings) =>
      ipcRenderer.invoke('host-bridge:browser-update', settings),
    openBrowser: () => ipcRenderer.invoke('host-bridge:browser-open'),
    listGrants: () => ipcRenderer.invoke('host-bridge:grants-list'),
    revokeGrant: (grant: { capability: string; resource: string }) =>
      ipcRenderer.invoke('host-bridge:grant-revoke', grant),
    revokeAllGrants: () => ipcRenderer.invoke('host-bridge:grants-revoke-all'),
  },
  calendars: {
    list: () => ipcRenderer.invoke('calendars:list'),
    prepare: () => ipcRenderer.invoke('calendars:prepare'),
    // Carries a password: never log it.
    test: (payload: import('./shared/types/calendars').CalendarTestPayload) =>
      ipcRenderer.invoke('calendars:test', payload),
    // Carries a password: never log it.
    connect: (payload: import('./shared/types/calendars').CalendarConnectPayload) =>
      ipcRenderer.invoke('calendars:connect', payload),
    setAccess: (payload: import('./shared/types/calendars').CalendarAccessPayload) =>
      ipcRenderer.invoke('calendars:set-access', payload),
    recheck: (payload: import('./shared/types/calendars').CalendarSlugPayload) =>
      ipcRenderer.invoke('calendars:recheck', payload),
    remove: (payload: import('./shared/types/calendars').CalendarSlugPayload) =>
      ipcRenderer.invoke('calendars:remove', payload),
    onProgress: (callback: (event: import('./shared/types/calendars').CalendarProgressEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        progress: import('./shared/types/calendars').CalendarProgressEvent
      ) => callback(progress);
      ipcRenderer.on('calendars:progress', handler);
      return () => ipcRenderer.removeListener('calendars:progress', handler);
    },
  },
  hermesVault: {
    listLogins: (payload: { agentSlug: string }) =>
      ipcRenderer.invoke('hermes-vault:list', payload),
    listSources: (payload: { agentSlug: string }) =>
      ipcRenderer.invoke('hermes-vault:sources', payload),
    // Carries a password: never log it.
    addLogin: (payload: import('./shared/types/hermesVault').VaultAddLoginPayload) =>
      ipcRenderer.invoke('hermes-vault:add-login', payload),
    // Carries a password: never log it.
    replacePassword: (payload: import('./shared/types/hermesVault').VaultReplacePasswordPayload) =>
      ipcRenderer.invoke('hermes-vault:replace-password', payload),
    removeLogin: (payload: import('./shared/types/hermesVault').VaultRemovePayload) =>
      ipcRenderer.invoke('hermes-vault:remove', payload),
    // Carries a master password: never log it.
    unlockSource: (payload: import('./shared/types/hermesVault').VaultUnlockPayload) =>
      ipcRenderer.invoke('hermes-vault:unlock', payload),
    lockSource: (payload: import('./shared/types/hermesVault').VaultLockPayload) =>
      ipcRenderer.invoke('hermes-vault:lock', payload),
  },
  hermesChat: {
    listThreads: () => ipcRenderer.invoke('hermes-chat:list-threads'),
    createHermesChat: (
      payload?: import('./shared/types/hermesChat').HermesCreateHermesChatPayload
    ) => ipcRenderer.invoke('hermes-chat:create-hermes-chat', payload),
    moveToProject: (payload: import('./shared/types/hermesChat').HermesMoveToProjectPayload) =>
      ipcRenderer.invoke('hermes-chat:move-to-project', payload),
    undoProjectMove: (
      payload: import('./shared/types/hermesChat').HermesUndoProjectMovePayload
    ) => ipcRenderer.invoke('hermes-chat:undo-project-move', payload),
    listProjectMarks: (payload: { sessionId: string }) =>
      ipcRenderer.invoke('hermes-chat:project-marks', payload),
    listMentions: (payload?: import('./shared/types/hermesChat').HermesMentionsListPayload) =>
      ipcRenderer.invoke('hermes-chat:list-mentions', payload),
    mentionsSummary: () => ipcRenderer.invoke('hermes-chat:mentions-summary'),
    markMentionsSeen: () => ipcRenderer.invoke('hermes-chat:mark-mentions-seen'),
    listRunningTurns: () => ipcRenderer.invoke('hermes-chat:running-list'),
    onRunningTurns: (
      callback: (turns: import('./shared/types/hermesChat').HermesRunningTurn[]) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesRunningTurn[]);
      ipcRenderer.on('hermes-chat:running', handler);
      return () => ipcRenderer.removeListener('hermes-chat:running', handler);
    },
    kanbanSnapshot: () => ipcRenderer.invoke('hermes-kanban:snapshot'),
    onKanbanSnapshot: (
      callback: (snapshot: import('./shared/types/hermesKanban').KanbanSnapshot) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesKanban').KanbanSnapshot);
      ipcRenderer.on('hermes-kanban:snapshot', handler);
      return () => ipcRenderer.removeListener('hermes-kanban:snapshot', handler);
    },
    kanbanTask: (taskId: string) => ipcRenderer.invoke('hermes-kanban:task', taskId),
    kanbanTaskLog: (taskId: string, tailBytes?: number) =>
      ipcRenderer.invoke('hermes-kanban:task-log', taskId, tailBytes),
    openKanbanBoard: () => ipcRenderer.invoke('hermes-kanban:open-board'),
    kanbanTaskAction: (
      taskId: string,
      action: import('./shared/types/hermesKanban').KanbanTaskAction
    ) => ipcRenderer.invoke('hermes-kanban:action', taskId, action),
    onKanbanOpenTask: (callback: (taskId: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, taskId: unknown) => {
        if (typeof taskId === 'string') callback(taskId);
      };
      ipcRenderer.on('hermes-kanban:open-task', handler);
      return () => ipcRenderer.removeListener('hermes-kanban:open-task', handler);
    },
    openAgentDm: (payload: import('./shared/types/hermesChat').HermesOpenAgentDmPayload) =>
      ipcRenderer.invoke('hermes-chat:open-agent-dm', payload),
    listAgents: () => ipcRenderer.invoke('hermes-agents:list'),
    createAgent: (payload: import('./shared/types/hermesChat').HermesAgentCreatePayload) =>
      ipcRenderer.invoke('hermes-agents:create', payload),
    updateAgent: (payload: import('./shared/types/hermesChat').HermesAgentUpdatePayload) =>
      ipcRenderer.invoke('hermes-agents:update', payload),
    getAgentSoul: (payload: import('./shared/types/hermesChat').HermesAgentSoulPayload) =>
      ipcRenderer.invoke('hermes-agents:soul', payload),
    revealAgentSoul: (payload: import('./shared/types/hermesChat').HermesAgentSoulPayload) =>
      ipcRenderer.invoke('hermes-agents:reveal-soul', payload),
    listChannels: () => ipcRenderer.invoke('hermes-channels:list'),
    createChannel: (payload: import('./shared/types/hermesChat').HermesChannelCreatePayload) =>
      ipcRenderer.invoke('hermes-channels:create', payload),
    addChannelMember: (
      payload: import('./shared/types/hermesChat').HermesChannelAddMemberPayload
    ) => ipcRenderer.invoke('hermes-channels:add-member', payload),
    removeChannelMember: (
      payload: import('./shared/types/hermesChat').HermesChannelAddMemberPayload
    ) => ipcRenderer.invoke('hermes-channels:remove-member', payload),
    renameChannel: (payload: import('./shared/types/hermesChat').HermesChannelRenamePayload) =>
      ipcRenderer.invoke('hermes-channels:rename', payload),
    deleteChannel: (payload: import('./shared/types/hermesChat').HermesChannelDeletePayload) =>
      ipcRenderer.invoke('hermes-channels:delete', payload),
    makeChannelFromHermesChat: (
      payload: import('./shared/types/hermesChat').HermesMakeChannelFromChatPayload
    ) => ipcRenderer.invoke('hermes-channels:make-from-chat', payload),
    setLastOpened: (
      payload: import('./shared/types/hermesChat').HermesSetLastOpenedPayload
    ) => ipcRenderer.invoke('hermes-channels:set-last-opened', payload),
    branchChat: (payload: import('./shared/types/hermesChat').HermesChatBranchPayload) =>
      ipcRenderer.invoke('hermes-chat:branch', payload),
    saveReply: (payload: import('./shared/types/hermesChat').HermesSaveReplyPayload) =>
      ipcRenderer.invoke('hermes-chat:save-reply', payload),
    revealProjectFile: (
      payload: import('./shared/types/hermesChat').HermesRevealProjectFilePayload
    ) => ipcRenderer.invoke('hermes-chat:reveal-project-file', payload),
    getHistory: (payload: import('./shared/types/hermesChat').HermesChatHistoryPayload) =>
      ipcRenderer.invoke('hermes-chat:get-history', payload),
    getSessionInference: (
      payload: import('./shared/types/hermesChat').HermesSessionInferencePayload
    ) => ipcRenderer.invoke('hermes-chat:get-session-inference', payload),
    setSessionInference: (
      payload: import('./shared/types/hermesChat').HermesSessionInferenceSetPayload
    ) => ipcRenderer.invoke('hermes-chat:set-session-inference', payload),
    clearSessionInference: (
      payload: import('./shared/types/hermesChat').HermesSessionInferencePayload
    ) => ipcRenderer.invoke('hermes-chat:clear-session-inference', payload),
    getContextBreakdown: (
      payload: import('./shared/types/hermesChat').HermesChatHistoryPayload
    ) => ipcRenderer.invoke('hermes-chat:context-breakdown', payload),
    startChat: (payload: import('./shared/types/hermesChat').HermesChatStartPayload) =>
      ipcRenderer.invoke('hermes-chat:start', payload),
    cancelChat: (payload: import('./shared/types/hermesChat').HermesChatCancelPayload) =>
      ipcRenderer.invoke('hermes-chat:cancel', payload),
    onChatChunk: (
      callback: (event: import('./shared/types/hermesChat').HermesChatChunkEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatChunkEvent);
      ipcRenderer.on('hermes-chat:chunk', handler);
      return () => ipcRenderer.removeListener('hermes-chat:chunk', handler);
    },
    onChatEnd: (
      callback: (event: import('./shared/types/hermesChat').HermesChatEndEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatEndEvent);
      ipcRenderer.on('hermes-chat:end', handler);
      return () => ipcRenderer.removeListener('hermes-chat:end', handler);
    },
    onChatError: (
      callback: (event: import('./shared/types/hermesChat').HermesChatErrorEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatErrorEvent);
      ipcRenderer.on('hermes-chat:error', handler);
      return () => ipcRenderer.removeListener('hermes-chat:error', handler);
    },
    onChatPhase: (
      callback: (event: import('./shared/types/hermesChat').HermesChatPhaseEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatPhaseEvent);
      ipcRenderer.on('hermes-chat:phase', handler);
      return () => ipcRenderer.removeListener('hermes-chat:phase', handler);
    },
    onChatSpeaker: (
      callback: (event: import('./shared/types/hermesChat').HermesChatSpeakerEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatSpeakerEvent);
      ipcRenderer.on('hermes-chat:speaker', handler);
      return () => ipcRenderer.removeListener('hermes-chat:speaker', handler);
    },
    onChatTool: (
      callback: (event: import('./shared/types/hermesChat').HermesChatToolEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatToolEvent);
      ipcRenderer.on('hermes-chat:tool', handler);
      return () => ipcRenderer.removeListener('hermes-chat:tool', handler);
    },
    onChatApproval: (
      callback: (event: import('./shared/types/hermesChat').HermesChatApprovalEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatApprovalEvent);
      ipcRenderer.on('hermes-chat:approval', handler);
      return () => ipcRenderer.removeListener('hermes-chat:approval', handler);
    },
    onChatCredentialRequest: (
      callback: (event: import('./shared/types/hermesChat').HermesChatCredentialRequestEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatCredentialRequestEvent);
      ipcRenderer.on('hermes-chat:credential-request', handler);
      return () => ipcRenderer.removeListener('hermes-chat:credential-request', handler);
    },
    onChatTurnStats: (
      callback: (event: import('./shared/types/hermesChat').HermesChatTurnStats) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/hermesChat').HermesChatTurnStats);
      ipcRenderer.on('hermes-chat:turn-stats', handler);
      return () => ipcRenderer.removeListener('hermes-chat:turn-stats', handler);
    },
    onSessionsChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('hermes-chat:sessions-changed', handler);
      return () => ipcRenderer.removeListener('hermes-chat:sessions-changed', handler);
    },
    respondApproval: (
      payload: import('./shared/types/hermesChat').HermesChatApprovalRespondPayload
    ) => ipcRenderer.invoke('hermes-chat:approval-respond', payload),
    ackApproval: (
      payload: import('./shared/types/hermesChat').HermesChatApprovalAckPayload
    ) => ipcRenderer.invoke('hermes-chat:approval-received', payload),
    respondCredentialRequest: (
      payload: import('./shared/types/hermesChat').HermesChatCredentialRespondPayload
    ) => ipcRenderer.invoke('hermes-chat:credential-respond', payload),
    listPendingCredentialRequests: () => ipcRenderer.invoke('hermes-chat:credential-pending'),
    listProjects: () => ipcRenderer.invoke('hermes-projects:list'),
    pickFolder: () => ipcRenderer.invoke('hermes-projects:pick-folder'),
    createHostProject: (
      payload: import('./shared/types/hermesChat').HermesProjectCreateHostPayload
    ) => ipcRenderer.invoke('hermes-projects:create-host', payload),
    createEmptyProject: (
      payload: import('./shared/types/hermesChat').HermesProjectCreateEmptyPayload
    ) => ipcRenderer.invoke('hermes-projects:create-empty', payload),
    selectProject: (
      payload: import('./shared/types/hermesChat').HermesProjectSelectPayload
    ) => ipcRenderer.invoke('hermes-projects:select', payload),
    changeFolder: (
      payload: import('./shared/types/hermesChat').HermesProjectChangeFolderPayload
    ) => ipcRenderer.invoke('hermes-projects:change-folder', payload),
    patchProject: (
      payload: import('./shared/types/hermesChat').HermesProjectPatchPayload
    ) => ipcRenderer.invoke('hermes-projects:patch', payload),
    revealInFinder: (payload: { projectId: string }) =>
      ipcRenderer.invoke('hermes-projects:reveal', payload),
    listProjectTree: (payload: { projectId: string }) =>
      ipcRenderer.invoke('hermes-projects:tree', payload),
    completePath: (
      payload: import('./shared/types/hermesChat').HermesCompletePathPayload
    ) => ipcRenderer.invoke('hermes-projects:complete-path', payload),
    countProjectSources: (payload: { projectId: string }) =>
      ipcRenderer.invoke('hermes-projects:source-count', payload),
    inspectSources: (
      payload: import('./shared/types/hermesChat').HermesProjectSourcesInspectPayload
    ) => ipcRenderer.invoke('hermes-projects:sources-inspect', payload),
    addSourceFolder: (
      payload: import('./shared/types/hermesChat').HermesProjectSourcesAddPayload
    ) => ipcRenderer.invoke('hermes-projects:sources-add', payload),
    removeSource: (
      payload: import('./shared/types/hermesChat').HermesProjectSourcesRemovePayload
    ) => ipcRenderer.invoke('hermes-projects:sources-remove', payload),
    revealSource: (
      payload: import('./shared/types/hermesChat').HermesProjectSourcesRevealPayload
    ) => ipcRenderer.invoke('hermes-projects:sources-reveal', payload),
    refreshIndex: (
      payload: import('./shared/types/hermesChat').HermesProjectSourcesInspectPayload
    ) => ipcRenderer.invoke('hermes-projects:sources-refresh', payload),
    listCodingFolders: () => ipcRenderer.invoke('coding-folders:list'),
    codingAgentBusy: () => ipcRenderer.invoke('coding-folders:busy'),
    grantCodingFolder: (payload: import('./shared/types/codingFolders').CodingGrantPayload) =>
      ipcRenderer.invoke('coding-folders:grant', payload),
    setProjectFolderCoding: (payload: import('./shared/types/codingFolders').CodingProjectFolderPayload) =>
      ipcRenderer.invoke('coding-folders:project-folder', payload),
    revokeCodingFolder: (payload: import('./shared/types/codingFolders').CodingRevokePayload) =>
      ipcRenderer.invoke('coding-folders:revoke', payload),
    createCodingFolder: (payload: import('./shared/types/codingFolders').CodingCreateFolderPayload) =>
      ipcRenderer.invoke('coding-folders:create-folder', payload),
    restartHermesForCodingFolders: () => ipcRenderer.invoke('coding-folders:restart-hermes'),
    retryCodingFolders: () => ipcRenderer.invoke('coding-folders:retry'),
    pickCodingFolder: () => ipcRenderer.invoke('coding-folders:pick'),
    verifyCodingFolders: (payload?: { force?: boolean }) =>
      ipcRenderer.invoke('coding-folders:verify', payload),
    removeCodingFolder: (payload: import('./shared/types/codingFolders').CodingRemoveFolderPayload) =>
      ipcRenderer.invoke('coding-folders:remove', payload),
    inspectFolderForDelete: (payload: { hostPath: string }) =>
      ipcRenderer.invoke('coding-folders:inspect-delete', payload),
    deleteCodingFolder: (payload: import('./shared/types/codingFolders').CodingDeleteFolderPayload) =>
      ipcRenderer.invoke('coding-folders:delete', payload),
    showTrash: () => ipcRenderer.invoke('coding-folders:show-trash'),
    newCodingFolderDefaults: () => ipcRenderer.invoke('coding-folders:new-folder-defaults'),
    checkNewCodingFolder: (payload: { parent: string; name: string }) =>
      ipcRenderer.invoke('coding-folders:check-new-folder', payload),
    pickCodingParent: (payload?: { defaultPath?: string }) =>
      ipcRenderer.invoke('coding-folders:pick-parent', payload),
    inspectCodingFolder: (payload: { hostPath: string }) =>
      ipcRenderer.invoke('coding-folders:inspect-folder', payload),
    onCodingAccessRequest: (
      callback: (event: import('./shared/types/codingFolders').CodingAccessRequestEvent) => void
    ) => {
      const handler = (_e: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as import('./shared/types/codingFolders').CodingAccessRequestEvent);
      ipcRenderer.on('coding-folders:access-request', handler);
      return () => ipcRenderer.removeListener('coding-folders:access-request', handler);
    },
    onCodingFoldersProgress: (callback: (message: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, message: unknown) =>
        callback(String(message));
      ipcRenderer.on('coding-folders:progress', handler);
      return () => ipcRenderer.removeListener('coding-folders:progress', handler);
    },
  },
  task: {
    get: (id: string) => ipcRenderer.invoke('task:get', id),
  },
  infrastructure: {
    listCatalog: () => ipcRenderer.invoke('infrastructure:list-catalog'),
    listManifests: () => ipcRenderer.invoke('infrastructure:list-manifests'),
    listInstances: () => ipcRenderer.invoke('infrastructure:list-instances'),
    createInstance: (
      arg:
        | string
        | { modelId: string; provider: string; displayName?: string }
        | { stackTypeId: string; displayName?: string },
      displayName?: string
    ) => ipcRenderer.invoke('infrastructure:create-instance', arg, displayName),
    checkPrerequisites: (provider: string, modelId?: string) =>
      ipcRenderer.invoke('infrastructure:check-prerequisites', provider, modelId),
    deleteInstance: (instanceId: string) =>
      ipcRenderer.invoke('infrastructure:delete-instance', instanceId),
    getVars: (instanceId: string) => ipcRenderer.invoke('infrastructure:get-vars', instanceId),
    saveVars: (instanceId: string, vars: Record<string, string | number | boolean>) =>
      ipcRenderer.invoke('infrastructure:save-vars', instanceId, vars),
    setSecret: (instanceId: string, varName: string, value: string) =>
      ipcRenderer.invoke('infrastructure:set-secret', instanceId, varName, value),
    apply: (instanceId: string) => ipcRenderer.invoke('infrastructure:apply', instanceId),
    destroy: (instanceId: string, payload: { confirm: boolean; confirmName?: string }) =>
      ipcRenderer.invoke('infrastructure:destroy', instanceId, payload),
    cancel: (instanceId: string) => ipcRenderer.invoke('infrastructure:cancel', instanceId),
    getStatus: (instanceId: string) => ipcRenderer.invoke('infrastructure:get-status', instanceId),
    getRuntime: (instanceId: string) => ipcRenderer.invoke('infrastructure:get-runtime', instanceId),
    checkTerraform: () => ipcRenderer.invoke('infrastructure:check-terraform'),
    checkTruss: () => ipcRenderer.invoke('infrastructure:check-truss'),
    subscribe: () => ipcRenderer.invoke('infrastructure:subscribe'),
    unsubscribe: () => ipcRenderer.invoke('infrastructure:unsubscribe'),
    onStatusChanged: (callback: (snapshot: unknown) => void) =>
      ipcRenderer.on('infrastructure:status-changed', (_event, snapshot) => callback(snapshot)),
  },
  urls: {
    openUrl: (url: string) => ipcRenderer.invoke('urls:open-url', url),
  },
});

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      appearance: {
        getTheme: () => Promise<import('./shared/theme').ThemePreference>;
        setTheme: (
          preference: import('./shared/theme').ThemePreference
        ) => Promise<{ success: boolean; error?: string }>;
      };
      appMenu: {
        onCommand: (
          callback: (command: import('./shared/appCommands').AppCommand) => void
        ) => () => void;
      };
      onboarding: {
        getStatus: () => Promise<import('./shared/types/onboarding').InferenceProvidersStatus>;
        listProviders: () => Promise<import('./shared/types/onboarding').OnboardingProviderConfig[]>;
        discoverProviderEndpoints: (
          input: import('./shared/types/onboarding').DiscoverProviderEndpointsInput
        ) => Promise<import('./shared/types/onboarding').DiscoverProviderEndpointsResult>;
        listProviderDeployments: (
          input: import('./shared/types/onboarding').ListProviderDeploymentsInput
        ) => Promise<import('./shared/types/onboarding').ListProviderDeploymentsResult>;
        listDeployableModels: (
          input: import('./shared/types/onboarding').ListDeployableModelsInput
        ) => Promise<import('./shared/types/onboarding').ListDeployableModelsResult>;
        adoptProviderEndpoint: (
          input: import('./shared/types/onboarding').AdoptProviderEndpointInput
        ) => Promise<import('./shared/types/onboarding').AdoptProviderEndpointResult>;
        startProviderSetup: (
          input: import('./shared/types/onboarding').StartProviderSetupInput
        ) => Promise<import('./shared/types/onboarding').StartProviderSetupResult>;
        saveOpenAiConfig: (
          input: import('./shared/types/onboarding').SaveOpenAiConfigInput
        ) => Promise<import('./shared/types/onboarding').SaveOpenAiConfigResult>;
        clearOpenAiConfig: (
          input?: import('./shared/types/onboarding').ClearLlmSlotInput
        ) => Promise<import('./shared/types/onboarding').ClearOpenAiConfigResult>;
        clearLlmSlot: (
          input: import('./shared/types/onboarding').ClearLlmSlotInput
        ) => Promise<import('./shared/types/onboarding').ClearOpenAiConfigResult>;
        setAppDefault: (
          input: import('./shared/types/onboarding').SetAppDefaultInput
        ) => Promise<import('./shared/types/onboarding').SetAppDefaultResult>;
        probeSlotHealth: (
          input: import('./shared/types/onboarding').ProbeSlotHealthInput
        ) => Promise<import('./shared/types/onboarding').ProbeSlotHealthResult>;
        clearPendingProviderSetup: () => Promise<import('./shared/types/onboarding').InferenceProvidersStatus>;
        getProviderFormDraft: (
          input: import('./shared/types/onboarding').GetProviderFormDraftInput
        ) => Promise<import('./shared/types/onboarding').GetProviderFormDraftResult>;
        saveProviderFormDraft: (
          input: import('./shared/types/onboarding').SaveProviderFormDraftInput
        ) => Promise<import('./shared/types/onboarding').SaveProviderFormDraftResult>;
        clearProviderFormDraft: (
          input?: import('./shared/types/onboarding').ClearProviderFormDraftInput
        ) => Promise<import('./shared/types/onboarding').ClearProviderFormDraftResult>;
        discoverLocalLlms: () => Promise<import('./shared/types/onboarding').DiscoverLocalLlmsResult>;
        adoptLocalLlm: (
          input: import('./shared/types/onboarding').AdoptLocalLlmInput
        ) => Promise<import('./shared/types/onboarding').AdoptLocalLlmResult>;
        dismissLocalLlm: (
          input: import('./shared/types/onboarding').DismissLocalLlmInput
        ) => Promise<import('./shared/types/onboarding').DismissLocalLlmResult>;
        listOAuthProviders: () => Promise<import('./shared/types/onboarding').ListOAuthProvidersResult>;
        startOAuthPkce: (
          input: import('./shared/types/onboarding').StartOAuthPkceInput
        ) => Promise<import('./shared/types/onboarding').StartOAuthPkceResult>;
        cancelOAuthPkce: () => Promise<import('./shared/types/onboarding').CancelOAuthPkceResult>;
        listEndpointModels: (
          input: import('./shared/types/onboarding').ListEndpointModelsInput
        ) => Promise<import('./shared/types/onboarding').ListEndpointModelsResult>;
        listConfiguredEndpointModels: (
          input?: import('./shared/types/onboarding').ListConfiguredEndpointModelsInput
        ) => Promise<import('./shared/types/onboarding').ListEndpointModelsResult>;
        saveLlmConnection: (
          input: import('./shared/types/onboarding').SaveLlmConnectionInput
        ) => Promise<import('./shared/types/onboarding').SaveLlmConnectionResult>;
        updateLlmModel: (
          input: import('./shared/types/onboarding').UpdateLlmModelInput
        ) => Promise<import('./shared/types/onboarding').UpdateLlmModelResult>;
        sendLlmTestMessage: (
          input: import('./shared/types/onboarding').SendLlmTestMessageInput
        ) => Promise<import('./shared/types/onboarding').SendLlmTestMessageResult>;
        onLocalLlmChanged: (
          callback: (payload: import('./shared/types/onboarding').LocalLlmChangedPayload) => void
        ) => () => void;
      };
      capability: {
        assess: () => Promise<import('./shared/types/capability').CapabilityAssessment>;
        getStatus: () => Promise<import('./shared/types/capability').CapabilityStatus>;
        acknowledge: () => Promise<import('./shared/types/capability').AcknowledgeCapabilityResult>;
        getRuntimeDiagnostics: (
          input?: import('./shared/types/containerRuntimeDiagnostics').GetRuntimeDiagnosticsInput
        ) => Promise<import('./shared/types/containerRuntimeDiagnostics').ContainerRuntimeDiagnostics>;
        getDebugLog: () => Promise<{ path: string; contents: string }>;
        onProgress: (callback: (message: string) => void) => () => void;
      };
      assistantStack: {
        getStatus: () => Promise<import('./shared/types/assistantStack').AssistantStackStatus>;
        getLifecycle: () => Promise<
          import('./shared/types/assistantStack').AssistantStackLifecycleSnapshot
        >;
        ensureRunning: () => Promise<import('./shared/types/assistantStack').EnsureAssistantStackResult>;
        ensureRunningInBackground: () => Promise<{ started: boolean }>;
        ensureAndApplyLlm: () => Promise<
          import('./shared/types/assistantStack').EnsureAssistantStackResult
        >;
        applyLlm: (
          payload?: import('./shared/types/assistantStack').ApplyAssistantLlmPayload
        ) => Promise<import('./shared/types/assistantStack').ApplyAssistantLlmResult>;
        stop: () => Promise<import('./shared/types/assistantStack').StopAssistantStackResult>;
        resetInstall: () => Promise<{ success: boolean; error?: string }>;
        onProgress: (callback: (message: string) => void) => () => void;
        onLifecycle: (
          callback: (
            snapshot: import('./shared/types/assistantStack').AssistantStackLifecycleSnapshot
          ) => void
        ) => () => void;
      };
      resources: {
        getSnapshot: () => Promise<import('./shared/types/hostResources').HostResourceSnapshot>;
        getComposeInventory: () => Promise<
          import('./shared/types/composeInventory').ComposeInventorySnapshot
        >;
        subscribeComposeInventory: (
          callback: (
            snapshot: import('./shared/types/composeInventory').ComposeInventorySnapshot
          ) => void
        ) => () => void;
      };
      hostBridge: {
        onApproval: (
          callback: (event: import('./shared/types/hostBridge').HostBridgeApprovalEvent) => void
        ) => () => void;
        onApprovalCleared: (callback: (event: { id: string }) => void) => () => void;
        respondApproval: (
          payload: import('./shared/types/hostBridge').HostBridgeApprovalRespondPayload
        ) => Promise<{ success: boolean; error?: string }>;
        listPendingApprovals: () => Promise<
          import('./shared/types/hostBridge').HostBridgeApprovalEvent[]
        >;
        getToolsState: () => Promise<import('./shared/types/hostBridge').HostToolsState>;
        onToolsState: (
          callback: (state: import('./shared/types/hostBridge').HostToolsState) => void
        ) => () => void;
        getBrowserState: () => Promise<import('./shared/types/hostBridge').BoundaryBrowserState>;
        updateBrowserSettings: (
          settings: import('./shared/types/hostBridge').HostBridgeBrowserSettings
        ) => Promise<import('./shared/types/hostBridge').BoundaryBrowserUpdateResult>;
        openBrowser: () => Promise<{ success: boolean; error?: string }>;
        listGrants: () => Promise<import('./shared/types/hostBridge').HostBridgeGrant[]>;
        revokeGrant: (grant: {
          capability: string;
          resource: string;
        }) => Promise<import('./shared/types/hostBridge').HostBridgeGrant[]>;
        revokeAllGrants: () => Promise<import('./shared/types/hostBridge').HostBridgeGrant[]>;
      };
      calendars: {
        list: () => Promise<import('./shared/types/calendars').CalendarListResult>;
        prepare: () => Promise<import('./shared/types/calendars').CalendarPrepareResult>;
        test: (
          payload: import('./shared/types/calendars').CalendarTestPayload
        ) => Promise<import('./shared/types/calendars').CalendarTestResult>;
        connect: (
          payload: import('./shared/types/calendars').CalendarConnectPayload
        ) => Promise<import('./shared/types/calendars').CalendarActionResult>;
        setAccess: (
          payload: import('./shared/types/calendars').CalendarAccessPayload
        ) => Promise<import('./shared/types/calendars').CalendarActionResult>;
        recheck: (
          payload: import('./shared/types/calendars').CalendarSlugPayload
        ) => Promise<import('./shared/types/calendars').CalendarActionResult>;
        remove: (
          payload: import('./shared/types/calendars').CalendarSlugPayload
        ) => Promise<import('./shared/types/calendars').CalendarActionResult>;
        onProgress: (
          callback: (event: import('./shared/types/calendars').CalendarProgressEvent) => void
        ) => () => void;
      };
      hermesVault: {
        listLogins: (payload: {
          agentSlug: string;
        }) => Promise<import('./shared/types/hermesVault').VaultListResult>;
        listSources: (payload: {
          agentSlug: string;
        }) => Promise<import('./shared/types/hermesVault').VaultSourcesResult>;
        addLogin: (
          payload: import('./shared/types/hermesVault').VaultAddLoginPayload
        ) => Promise<import('./shared/types/hermesVault').VaultActionResult>;
        replacePassword: (
          payload: import('./shared/types/hermesVault').VaultReplacePasswordPayload
        ) => Promise<import('./shared/types/hermesVault').VaultActionResult>;
        removeLogin: (
          payload: import('./shared/types/hermesVault').VaultRemovePayload
        ) => Promise<import('./shared/types/hermesVault').VaultActionResult>;
        unlockSource: (
          payload: import('./shared/types/hermesVault').VaultUnlockPayload
        ) => Promise<import('./shared/types/hermesVault').VaultActionResult>;
        lockSource: (
          payload: import('./shared/types/hermesVault').VaultLockPayload
        ) => Promise<import('./shared/types/hermesVault').VaultActionResult>;
      };
      hermesChat: {
        listThreads: () => Promise<import('./shared/types/hermesChat').HermesChatListThreadsResult>;
        createHermesChat: (
          payload?: import('./shared/types/hermesChat').HermesCreateHermesChatPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChatCreateThreadResult>;
        moveToProject: (
          payload: import('./shared/types/hermesChat').HermesMoveToProjectPayload
        ) => Promise<import('./shared/types/hermesChat').HermesMoveToProjectResult>;
        undoProjectMove: (
          payload: import('./shared/types/hermesChat').HermesUndoProjectMovePayload
        ) => Promise<import('./shared/types/hermesChat').HermesMoveToProjectResult>;
        listProjectMarks: (payload: {
          sessionId: string;
        }) => Promise<import('./shared/types/hermesChat').SessionProjectMark[]>;
        listMentions: (
          payload?: import('./shared/types/hermesChat').HermesMentionsListPayload
        ) => Promise<import('./shared/types/hermesChat').HermesMentionsListResult>;
        mentionsSummary: () => Promise<import('./shared/types/hermesChat').HermesMentionsSummaryResult>;
        markMentionsSeen: () => Promise<{ success: boolean }>;
        listRunningTurns: () => Promise<import('./shared/types/hermesChat').HermesRunningTurn[]>;
        onRunningTurns: (
          callback: (turns: import('./shared/types/hermesChat').HermesRunningTurn[]) => void
        ) => () => void;
        kanbanSnapshot: () => Promise<import('./shared/types/hermesKanban').KanbanSnapshot>;
        onKanbanSnapshot: (
          callback: (snapshot: import('./shared/types/hermesKanban').KanbanSnapshot) => void
        ) => () => void;
        kanbanTask: (
          taskId: string
        ) => Promise<import('./shared/types/hermesKanban').KanbanTaskDetailResult>;
        kanbanTaskLog: (
          taskId: string,
          tailBytes?: number
        ) => Promise<import('./shared/types/hermesKanban').KanbanTaskLogResult>;
        openKanbanBoard: () => Promise<void>;
        kanbanTaskAction: (
          taskId: string,
          action: import('./shared/types/hermesKanban').KanbanTaskAction
        ) => Promise<import('./shared/types/hermesKanban').KanbanTaskActionResult>;
        onKanbanOpenTask: (callback: (taskId: string) => void) => () => void;
        openAgentDm: (
          payload: import('./shared/types/hermesChat').HermesOpenAgentDmPayload
        ) => Promise<import('./shared/types/hermesChat').HermesOpenAgentDmResult>;
        listAgents: () => Promise<import('./shared/types/hermesChat').HermesAgentsListResult>;
        createAgent: (
          payload: import('./shared/types/hermesChat').HermesAgentCreatePayload
        ) => Promise<import('./shared/types/hermesChat').HermesAgentCreateResult>;
        updateAgent: (
          payload: import('./shared/types/hermesChat').HermesAgentUpdatePayload
        ) => Promise<import('./shared/types/hermesChat').HermesAgentUpdateResult>;
        getAgentSoul: (
          payload: import('./shared/types/hermesChat').HermesAgentSoulPayload
        ) => Promise<import('./shared/types/hermesChat').HermesAgentSoulResult>;
        revealAgentSoul: (
          payload: import('./shared/types/hermesChat').HermesAgentSoulPayload
        ) => Promise<{ success: boolean; error?: string }>;
        listChannels: () => Promise<import('./shared/types/hermesChat').HermesChannelsListResult>;
        createChannel: (
          payload: import('./shared/types/hermesChat').HermesChannelCreatePayload
        ) => Promise<import('./shared/types/hermesChat').HermesChannelCreateResult>;
        addChannelMember: (
          payload: import('./shared/types/hermesChat').HermesChannelAddMemberPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChannelAddMemberResult>;
        removeChannelMember: (
          payload: import('./shared/types/hermesChat').HermesChannelAddMemberPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChannelAddMemberResult>;
        renameChannel: (
          payload: import('./shared/types/hermesChat').HermesChannelRenamePayload
        ) => Promise<import('./shared/types/hermesChat').HermesChannelRenameResult>;
        deleteChannel: (
          payload: import('./shared/types/hermesChat').HermesChannelDeletePayload
        ) => Promise<import('./shared/types/hermesChat').HermesChannelDeleteResult>;
        makeChannelFromHermesChat: (
          payload: import('./shared/types/hermesChat').HermesMakeChannelFromChatPayload
        ) => Promise<import('./shared/types/hermesChat').HermesMakeChannelFromChatResult>;
        setLastOpened: (
          payload: import('./shared/types/hermesChat').HermesSetLastOpenedPayload
        ) => Promise<import('./shared/types/hermesChat').HermesSetLastOpenedResult>;
        branchChat: (
          payload: import('./shared/types/hermesChat').HermesChatBranchPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChatBranchResult>;
        saveReply: (
          payload: import('./shared/types/hermesChat').HermesSaveReplyPayload
        ) => Promise<import('./shared/types/hermesChat').HermesSaveReplyResult>;
        revealProjectFile: (
          payload: import('./shared/types/hermesChat').HermesRevealProjectFilePayload
        ) => Promise<import('./shared/types/hermesChat').HermesRevealProjectFileResult>;
        getHistory: (
          payload: import('./shared/types/hermesChat').HermesChatHistoryPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChatHistoryResult>;
        getSessionInference: (
          payload: import('./shared/types/hermesChat').HermesSessionInferencePayload
        ) => Promise<import('./shared/types/hermesChat').HermesSessionInferenceResult>;
        setSessionInference: (
          payload: import('./shared/types/hermesChat').HermesSessionInferenceSetPayload
        ) => Promise<import('./shared/types/hermesChat').HermesSessionInferenceResult>;
        clearSessionInference: (
          payload: import('./shared/types/hermesChat').HermesSessionInferencePayload
        ) => Promise<import('./shared/types/hermesChat').HermesSessionInferenceResult>;
        getContextBreakdown: (
          payload: import('./shared/types/hermesChat').HermesChatHistoryPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChatBreakdownResult>;
        startChat: (
          payload: import('./shared/types/hermesChat').HermesChatStartPayload
        ) => Promise<import('./shared/types/hermesChat').HermesChatStartResult>;
        cancelChat: (
          payload: import('./shared/types/hermesChat').HermesChatCancelPayload
        ) => Promise<{ success: boolean }>;
        onChatChunk: (
          callback: (event: import('./shared/types/hermesChat').HermesChatChunkEvent) => void
        ) => () => void;
        onChatEnd: (
          callback: (event: import('./shared/types/hermesChat').HermesChatEndEvent) => void
        ) => () => void;
        onChatError: (
          callback: (event: import('./shared/types/hermesChat').HermesChatErrorEvent) => void
        ) => () => void;
        onChatPhase: (
          callback: (event: import('./shared/types/hermesChat').HermesChatPhaseEvent) => void
        ) => () => void;
        onChatSpeaker: (
          callback: (event: import('./shared/types/hermesChat').HermesChatSpeakerEvent) => void
        ) => () => void;
        onChatTool: (
          callback: (event: import('./shared/types/hermesChat').HermesChatToolEvent) => void
        ) => () => void;
        onChatApproval: (
          callback: (event: import('./shared/types/hermesChat').HermesChatApprovalEvent) => void
        ) => () => void;
        onChatCredentialRequest: (
          callback: (event: import('./shared/types/hermesChat').HermesChatCredentialRequestEvent) => void
        ) => () => void;
        onChatTurnStats: (
          callback: (event: import('./shared/types/hermesChat').HermesChatTurnStats) => void
        ) => () => void;
        onSessionsChanged: (callback: () => void) => () => void;
        respondApproval: (
          payload: import('./shared/types/hermesChat').HermesChatApprovalRespondPayload
        ) => Promise<{ success: boolean; error?: string }>;
        ackApproval: (
          payload: import('./shared/types/hermesChat').HermesChatApprovalAckPayload
        ) => Promise<{ success: boolean; error?: string }>;
        respondCredentialRequest: (
          payload: import('./shared/types/hermesChat').HermesChatCredentialRespondPayload
        ) => Promise<{ success: boolean; error?: string }>;
        listPendingCredentialRequests: () => Promise<
          import('./shared/types/hermesChat').HermesChatCredentialRequestEvent[]
        >;
        listProjects: () => Promise<import('./shared/types/hermesChat').HermesProjectsListResult>;
        pickFolder: () => Promise<{
          success: boolean;
          hostPath?: string;
          canceled?: boolean;
          error?: string;
        }>;
        createHostProject: (
          payload: import('./shared/types/hermesChat').HermesProjectCreateHostPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectResult>;
        createEmptyProject: (
          payload: import('./shared/types/hermesChat').HermesProjectCreateEmptyPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectResult>;
        selectProject: (
          payload: import('./shared/types/hermesChat').HermesProjectSelectPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectResult>;
        changeFolder: (
          payload: import('./shared/types/hermesChat').HermesProjectChangeFolderPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectResult>;
        patchProject: (
          payload: import('./shared/types/hermesChat').HermesProjectPatchPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectResult>;
        revealInFinder: (payload: { projectId: string }) => Promise<{
          success: boolean;
          error?: string;
        }>;
        listProjectTree: (payload: { projectId: string }) => Promise<
          import('./shared/types/hermesChat').HermesProjectTreeResult
        >;
        completePath: (
          payload: import('./shared/types/hermesChat').HermesCompletePathPayload
        ) => Promise<import('./shared/types/hermesChat').HermesCompletePathResult>;
        countProjectSources: (payload: { projectId: string }) => Promise<number | null>;
        inspectSources: (
          payload: import('./shared/types/hermesChat').HermesProjectSourcesInspectPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectSourcesResult>;
        addSourceFolder: (
          payload: import('./shared/types/hermesChat').HermesProjectSourcesAddPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectSourcesResult>;
        removeSource: (
          payload: import('./shared/types/hermesChat').HermesProjectSourcesRemovePayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectSourcesResult>;
        revealSource: (
          payload: import('./shared/types/hermesChat').HermesProjectSourcesRevealPayload
        ) => Promise<{ success: boolean; error?: string }>;
        refreshIndex: (
          payload: import('./shared/types/hermesChat').HermesProjectSourcesInspectPayload
        ) => Promise<import('./shared/types/hermesChat').HermesProjectSourcesResult>;
        listCodingFolders: () => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        codingAgentBusy: () => Promise<import('./shared/types/codingFolders').CodingAgentBusy>;
        grantCodingFolder: (
          payload: import('./shared/types/codingFolders').CodingGrantPayload
        ) => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        setProjectFolderCoding: (
          payload: import('./shared/types/codingFolders').CodingProjectFolderPayload
        ) => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        revokeCodingFolder: (
          payload: import('./shared/types/codingFolders').CodingRevokePayload
        ) => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        createCodingFolder: (
          payload: import('./shared/types/codingFolders').CodingCreateFolderPayload
        ) => Promise<import('./shared/types/codingFolders').CodingCreateFolderResult>;
        restartHermesForCodingFolders: () => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        retryCodingFolders: () => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        pickCodingFolder: () => Promise<import('./shared/types/codingFolders').CodingFolderInspect>;
        verifyCodingFolders: (payload?: { force?: boolean }) => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        removeCodingFolder: (
          payload: import('./shared/types/codingFolders').CodingRemoveFolderPayload
        ) => Promise<import('./shared/types/codingFolders').CodingFoldersResult>;
        inspectFolderForDelete: (payload: {
          hostPath: string;
        }) => Promise<import('./shared/types/codingFolders').CodingDeleteInspect>;
        deleteCodingFolder: (
          payload: import('./shared/types/codingFolders').CodingDeleteFolderPayload
        ) => Promise<import('./shared/types/codingFolders').CodingDeleteFolderResult>;
        showTrash: () => Promise<void>;
        newCodingFolderDefaults: () => Promise<import('./shared/types/codingFolders').CodingNewFolderDefaults>;
        checkNewCodingFolder: (payload: {
          parent: string;
          name: string;
        }) => Promise<import('./shared/types/codingFolders').CodingNewFolderCheck>;
        pickCodingParent: (payload?: { defaultPath?: string }) => Promise<{
          success: boolean;
          canceled?: boolean;
          hostPath?: string;
          error?: string;
        }>;
        inspectCodingFolder: (payload: { hostPath: string }) => Promise<import('./shared/types/codingFolders').CodingFolderInspect>;
        onCodingFoldersProgress: (callback: (message: string) => void) => () => void;
        onCodingAccessRequest: (
          callback: (event: import('./shared/types/codingFolders').CodingAccessRequestEvent) => void
        ) => () => void;
      };
      task: {
        get: (id: string) => Promise<Task | null>;
      };
      infrastructure: {
        listCatalog: () => Promise<import('./shared/types/infrastructure').ModelCatalogEntry[]>;
        listManifests: () => Promise<import('./shared/types/infrastructure').StackManifest[]>;
        listInstances: () => Promise<import('./shared/types/infrastructure').InfrastructureStackInstance[]>;
        createInstance: (
          arg:
            | string
            | import('./shared/types/infrastructure').CreateDeploymentInput
            | { stackTypeId: string; displayName?: string },
          displayName?: string
        ) => Promise<{
          success: boolean;
          instance?: import('./shared/types/infrastructure').InfrastructureStackInstance;
          error?: string;
        }>;
        checkPrerequisites: (
          provider: import('./shared/types/infrastructure').ProviderId,
          modelId?: string
        ) => Promise<import('./shared/types/infrastructure').InfrastructurePrerequisites>;
        deleteInstance: (instanceId: string) => Promise<{ success: boolean; error?: string }>;
        getVars: (instanceId: string) => Promise<{
          success: boolean;
          vars?: Record<string, string | number | boolean>;
          secretsConfigured?: import('./shared/types/infrastructure').StackSecretPreviews;
          error?: string;
        }>;
        saveVars: (
          instanceId: string,
          vars: Record<string, string | number | boolean>
        ) => Promise<{
          success: boolean;
          instance?: import('./shared/types/infrastructure').InfrastructureStackInstance;
          error?: string;
        }>;
        setSecret: (
          instanceId: string,
          varName: string,
          value: string
        ) => Promise<{ success: boolean; error?: string }>;
        apply: (instanceId: string) => Promise<{ success: boolean; taskId?: string; error?: string }>;
        destroy: (
          instanceId: string,
          payload: { confirm: boolean; confirmName?: string }
        ) => Promise<{ success: boolean; taskId?: string; error?: string }>;
        cancel: (instanceId: string) => Promise<{ success: boolean }>;
        getStatus: (
          instanceId: string
        ) => Promise<import('./shared/types/infrastructure').StackStatusSnapshot | null>;
        getRuntime: (
          instanceId: string
        ) => Promise<import('./shared/types/infrastructure').RunpodRuntimeSnapshot | null>;
        checkTerraform: () => Promise<import('./shared/types/infrastructure').TerraformCheckResult>;
        checkTruss: () => Promise<import('./shared/types/infrastructure').TrussCheckResult>;
        subscribe: () => Promise<{ success: boolean }>;
        unsubscribe: () => Promise<{ success: boolean }>;
        onStatusChanged: (
          callback: (snapshot: import('./shared/types/infrastructure').StackStatusSnapshot) => void
        ) => void;
      };
      urls: {
        openUrl: (url: string) => Promise<{ success: boolean }>;
      };
    };
  }
}
