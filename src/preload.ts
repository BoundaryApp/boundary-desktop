import { contextBridge } from 'electron';
import { createFileLogger } from './shared/utils/logger';
import './preloadLagProbe';
import { experimentBridges } from './preloadExperiments';
import { invoker, listen } from './preloadIpc';
import { APP_MENU_COMMAND_CHANNEL } from './shared/appCommands';
import type { IpcEventChannels } from './shared/ipc/channels';

const log = createFileLogger(undefined, 'preload');

// Previous builds forced localStorage.debug='*', which flooded the DevTools
// console and retained unbounded log memory. Clear that default once.
if (typeof localStorage !== 'undefined' && localStorage.getItem('debug') === '*') {
  localStorage.removeItem('debug');
}

const api = {
  appearance: {
    getTheme: invoker('appearance:get-theme'),
    setTheme: invoker('appearance:set-theme'),
  },
  appMenu: {
    onCommand: listen(APP_MENU_COMMAND_CHANNEL),
  },
  onboarding: {
    getStatus: invoker('onboarding:get-status'),
    clearLlmSlot: invoker('onboarding:clear-llm-slot'),
    reconnectSavedOpenRouterKey: invoker('onboarding:reconnect-saved-openrouter-key'),
    forgetSavedOpenRouterKey: invoker('onboarding:forget-saved-openrouter-key'),
    setAppDefault: invoker('onboarding:set-app-default'),
    setAppFallbacks: invoker('onboarding:set-app-fallbacks'),
    probeSlotHealth: invoker('onboarding:probe-slot-health'),
    discoverLocalLlms: invoker('onboarding:discover-local-llms'),
    adoptLocalLlm: invoker('onboarding:adopt-local-llm'),
    listOAuthProviders: invoker('onboarding:list-oauth-providers'),
    startOAuthPkce: invoker('onboarding:start-oauth-pkce'),
    cancelOAuthPkce: invoker('onboarding:cancel-oauth-pkce'),
    listEndpointModels: invoker('onboarding:list-endpoint-models'),
    listConfiguredEndpointModels: invoker('onboarding:list-configured-endpoint-models'),
    saveLlmConnection: invoker('onboarding:save-llm-connection'),
    updateLlmModel: invoker('onboarding:update-llm-model'),
    sendLlmTestMessage: invoker('onboarding:send-llm-test-message'),
    onLocalLlmChanged: listen('local-llm:changed'),
    onStatus: listen('onboarding:status'),
  },
  capability: {
    assess: invoker('capability:assess'),
    getStatus: invoker('capability:get-status'),
    acknowledge: invoker('capability:acknowledge'),
    getDebugLog: invoker('capability:get-debug-log'),
    onProgress: listen('capability:progress'),
  },
  setup: {
    getProgress: invoker('setup:get-progress'),
    recordOutcome: invoker('setup:record-outcome'),
    pickFolders: invoker('setup:pick-folders'),
    saveFolders: invoker('setup:save-folders'),
    applyFolders: invoker('setup:apply-folders'),
  },
  assistantStack: {
    getStatus: invoker('assistant-stack:get-status'),
    getLifecycle: invoker('assistant-stack:get-lifecycle'),
    ensureRunning: invoker('assistant-stack:ensure-running'),
    ensureRunningInBackground: invoker('assistant-stack:ensure-running-background'),
    ensureAndApplyLlm: invoker('assistant-stack:ensure-and-apply-llm'),
    onLifecycle: listen('assistant-stack:lifecycle'),
    onReady: listen('assistant-stack:ready'),
  },
  updates: {
    getState: invoker('updates:get-state'),
    check: invoker('updates:check'),
    download: invoker('updates:download'),
    restart: invoker('updates:restart'),
    restartWhenFinished: invoker('updates:restart-when-finished'),
    cancelWaiting: invoker('updates:cancel-waiting'),
    closeNotice: invoker('updates:close-notice'),
    skipVersion: invoker('updates:skip-version'),
    pageSeen: invoker('updates:page-seen'),
    setChannel: invoker('updates:set-channel'),
    setChecksEnabled: invoker('updates:set-checks-enabled'),
    moveToApplications: invoker('updates:move-to-applications'),
    onState: listen('updates:state'),
    onOpen: listen('updates:open'),
  },
  resources: {
    getSnapshot: invoker('resources:get-snapshot'),
    getComposeInventory: invoker('resources:get-compose-inventory'),
    /** Main pushes the inventory only while at least one subscriber is attached. */
    subscribeComposeInventory: (callback: (snapshot: IpcEventChannels['resources:compose-inventory']) => void) => {
      const remove = listen('resources:compose-inventory')(callback);
      invoker('resources:subscribe-compose-inventory')().catch((error: unknown) =>
        log('compose inventory subscribe failed: %O', error)
      );
      return () => {
        remove();
        invoker('resources:unsubscribe-compose-inventory')().catch((error: unknown) =>
          log('compose inventory unsubscribe failed: %O', error)
        );
      };
    },
  },
  circles: {
    getState: invoker('circles:get-state'),
    start: invoker('circles:start'),
    setDisplayName: invoker('circles:set-display-name'),
    create: invoker('circles:create'),
    join: invoker('circles:join'),
    createInvite: invoker('circles:create-invite'),
    revokeInvite: invoker('circles:revoke-invite'),
    setRole: invoker('circles:set-role'),
    removeMember: invoker('circles:remove-member'),
    leave: invoker('circles:leave'),
    setProviderSettings: invoker('circles:set-provider-settings'),
    setSharing: invoker('circles:set-sharing'),
    revealDiagnostics: invoker('circles:reveal-diagnostics'),
    onState: listen('circles:state'),
  },
  hostBridge: {
    onApproval: listen('host-bridge:approval'),
    onApprovalCleared: listen('host-bridge:approval-cleared'),
    respondApproval: invoker('host-bridge:approval-respond'),
    listPendingApprovals: invoker('host-bridge:approvals-pending'),
    getToolsState: invoker('host-bridge:tools-state'),
    onToolsState: listen('host-bridge:tools-state'),
    getBrowserState: invoker('host-bridge:browser-state'),
    updateBrowserSettings: invoker('host-bridge:browser-update'),
    openBrowser: invoker('host-bridge:browser-open'),
    listGrants: invoker('host-bridge:grants-list'),
    revokeGrant: invoker('host-bridge:grant-revoke'),
    revokeAllGrants: invoker('host-bridge:grants-revoke-all'),
    agentStopped: invoker('host-bridge:agent-stopped'),
    rotateTokens: invoker('host-bridge:rotate-tokens'),
  },
  calendars: {
    list: invoker('calendars:list'),
    prepare: invoker('calendars:prepare'),
    // Carries a password: never log it.
    test: invoker('calendars:test'),
    // Carries a password: never log it.
    connect: invoker('calendars:connect'),
    setAccess: invoker('calendars:set-access'),
    recheck: invoker('calendars:recheck'),
    recheckAll: invoker('calendars:recheck-all'),
    // Carries a password: never log it.
    replacePassword: invoker('calendars:replace-password'),
    remove: invoker('calendars:remove'),
    onChanged: listen('calendars:changed'),
    onProgress: listen('calendars:progress'),
  },
  hermesVault: {
    listLogins: invoker('hermes-vault:list'),
    listSources: invoker('hermes-vault:sources'),
    // Carries a password: never log it.
    addLogin: invoker('hermes-vault:add-login'),
    // Carries a password: never log it.
    replacePassword: invoker('hermes-vault:replace-password'),
    removeLogin: invoker('hermes-vault:remove'),
    // Carries a master password: never log it.
    unlockSource: invoker('hermes-vault:unlock'),
    lockSource: invoker('hermes-vault:lock'),
  },
  hermesChat: {
    listThreads: invoker('hermes-chat:list-threads'),
    createHermesChat: invoker('hermes-chat:create-hermes-chat'),
    moveToProject: invoker('hermes-chat:move-to-project'),
    undoProjectMove: invoker('hermes-chat:undo-project-move'),
    listProjectMarks: invoker('hermes-chat:project-marks'),
    listMentions: invoker('hermes-chat:list-mentions'),
    markMentionsSeen: invoker('hermes-chat:mark-mentions-seen'),
    listRunningTurns: invoker('hermes-chat:running-list'),
    onRunningTurns: listen('hermes-chat:running'),
    openAgentDm: invoker('hermes-chat:open-agent-dm'),
    branchChat: invoker('hermes-chat:branch'),
    saveReply: invoker('hermes-chat:save-reply'),
    revealProjectFile: invoker('hermes-chat:reveal-project-file'),
    getHistory: invoker('hermes-chat:get-history'),
    getSessionInference: invoker('hermes-chat:get-session-inference'),
    setSessionInference: invoker('hermes-chat:set-session-inference'),
    clearSessionInference: invoker('hermes-chat:clear-session-inference'),
    getContextBreakdown: invoker('hermes-chat:context-breakdown'),
    startChat: invoker('hermes-chat:start'),
    cancelChat: invoker('hermes-chat:cancel'),
    onChatChunk: listen('hermes-chat:chunk'),
    onChatEnd: listen('hermes-chat:end'),
    onChatError: listen('hermes-chat:error'),
    onChatPhase: listen('hermes-chat:phase'),
    onChatSpeaker: listen('hermes-chat:speaker'),
    onChatTool: listen('hermes-chat:tool'),
    onChatApproval: listen('hermes-chat:approval'),
    onChatCredentialRequest: listen('hermes-chat:credential-request'),
    onChatTurnStats: listen('hermes-chat:turn-stats'),
    onSessionsChanged: listen('hermes-chat:sessions-changed'),
    respondApproval: invoker('hermes-chat:approval-respond'),
    ackApproval: invoker('hermes-chat:approval-received'),
    respondCredentialRequest: invoker('hermes-chat:credential-respond'),
    listPendingCredentialRequests: invoker('hermes-chat:credential-pending'),
    listPendingApprovals: invoker('hermes-chat:approval-pending'),
  },
  projects: {
    list: invoker('hermes-projects:list'),
    pickFolder: invoker('hermes-projects:pick-folder'),
    createHost: invoker('hermes-projects:create-host'),
    createEmpty: invoker('hermes-projects:create-empty'),
    select: invoker('hermes-projects:select'),
    changeFolder: invoker('hermes-projects:change-folder'),
    patch: invoker('hermes-projects:patch'),
    reveal: invoker('hermes-projects:reveal'),
    completePath: invoker('hermes-projects:complete-path'),
    countSources: invoker('hermes-projects:source-count'),
    inspectSources: invoker('hermes-projects:sources-inspect'),
    addSourceFolder: invoker('hermes-projects:sources-add'),
    removeSource: invoker('hermes-projects:sources-remove'),
    revealSource: invoker('hermes-projects:sources-reveal'),
    refreshIndex: invoker('hermes-projects:sources-refresh'),
  },
  channels: {
    list: invoker('hermes-channels:list'),
    create: invoker('hermes-channels:create'),
    addMember: invoker('hermes-channels:add-member'),
    removeMember: invoker('hermes-channels:remove-member'),
    rename: invoker('hermes-channels:rename'),
    remove: invoker('hermes-channels:delete'),
    makeFromChat: invoker('hermes-channels:make-from-chat'),
    setLastOpened: invoker('hermes-channels:set-last-opened'),
  },
  agents: {
    list: invoker('hermes-agents:list'),
    create: invoker('hermes-agents:create'),
    update: invoker('hermes-agents:update'),
    getSoul: invoker('hermes-agents:soul'),
    revealSoul: invoker('hermes-agents:reveal-soul'),
  },
  kanban: {
    snapshot: invoker('hermes-kanban:snapshot'),
    onSnapshot: listen('hermes-kanban:snapshot'),
    task: invoker('hermes-kanban:task'),
    taskLog: invoker('hermes-kanban:task-log'),
    openBoard: invoker('hermes-kanban:open-board'),
    boardView: invoker('hermes-kanban:board-view'),
    taskAction: invoker('hermes-kanban:action'),
    onOpenTask: listen('hermes-kanban:open-task'),
  },
  codingFolders: {
    list: invoker('coding-folders:list'),
    busy: invoker('coding-folders:busy'),
    grant: invoker('coding-folders:grant'),
    setProjectFolder: invoker('coding-folders:project-folder'),
    revoke: invoker('coding-folders:revoke'),
    createFolder: invoker('coding-folders:create-folder'),
    restartHermes: invoker('coding-folders:restart-hermes'),
    retry: invoker('coding-folders:retry'),
    pick: invoker('coding-folders:pick'),
    verify: invoker('coding-folders:verify'),
    remove: invoker('coding-folders:remove'),
    inspectForDelete: invoker('coding-folders:inspect-delete'),
    deleteFolder: invoker('coding-folders:delete'),
    showTrash: invoker('coding-folders:show-trash'),
    newFolderDefaults: invoker('coding-folders:new-folder-defaults'),
    checkNewFolder: invoker('coding-folders:check-new-folder'),
    pickParent: invoker('coding-folders:pick-parent'),
    inspectFolder: invoker('coding-folders:inspect-folder'),
    onAccessRequest: listen('coding-folders:access-request'),
    onProgress: listen('coding-folders:progress'),
  },
  urls: {
    openUrl: invoker('urls:open-url'),
  },
};

/** The renderer's `window.electronAPI`: the object above plus the experiments' namespaces. */
export type ElectronAPI = typeof api & ExperimentBridges;

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

log('Preload script executing, exposing electronAPI...');
contextBridge.exposeInMainWorld('electronAPI', { ...api, ...experimentBridges() });
