// First: the lag probe times IPC handlers, so it must patch ipcMain before any register.
import { startLagProbe } from './perf/lagProbe';
import { APP_ID, APP_NAME, INSTANCE_NAME } from '../shared/buildIdentity';
import { persistDebugLog, serializeError, getDebugLogPath } from './persistDebugLog';
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerAppearanceHandlers } from './appearance';
import { registerAppBadgeHandlers, setLinuxDesktopName } from './appBadge';
import { createAppMenu } from './appMenu';
import { createConfigStore } from './configStore';
import { createMainWindowFactory, saveDisplayForQuit } from './mainWindow';
import { installUpdate, registerQuitHandlers, registerShutdownHooks, stopStackThen } from './quit';
import { registerDesktopAgentSettingHandlers } from './services/desktopAgent/ipcHandlers';
import { onDesktopAgentChange } from './services/desktopAgent/desktopAgentSetting';
import { closeDesktopAgentWindows } from './services/desktopAgent/desktopAgentWindows';
import { registerCallHandlers } from './callQuit';
import { registerRingAlertHandlers } from './callRingAlerts';
import { registerMediaHandlers } from './services/media';
import { registerUrlHandlers } from './openExternal';
import { registerBugReportHandlers } from './services/bugReport/ipcHandlers';
import { sendEvent } from './ipc';
import { registerOnboardingHandlers } from './services/onboarding/ipcHandlers';
import { registerCapabilityHandlers } from './services/capability/ipcHandlers';
import { registerSetupHandlers } from './services/setup/ipcHandlers';
import { registerAssistantStackHandlers } from './services/assistant/ipcHandlers';
import { registerAddonHandlers } from './services/addons/ipcHandlers';
import { registerResourceHandlers } from './services/resources/ipcHandlers';
import { registerHermesChatHandlers } from './services/assistant/hermes/hermesChatIpc';
import { registerKanbanHandlers } from './services/assistant/hermes/hermesKanbanIpc';
import { registerAgentHandlers } from './services/assistant/hermes/hermesAgentsIpc';
import { registerChannelHandlers } from './services/assistant/hermes/hermesChannelsIpc';
import { registerProjectHandlers } from './services/assistant/hermes/hermesProjectsIpc';
import { registerCodingFolderHandlers } from './services/assistant/coding/codingIpc';
import { registerWritingVoiceHandlers } from './services/assistant/writingVoices/writingVoicesIpc';
import { registerWritingCheckHandlers } from './services/assistant/writingCheck/writingCheckIpc';
import { registerHermesVaultHandlers } from './services/assistant/hermes/hermesVaultIpc';
import { registerCalendarHandlers } from './services/assistant/calendar/calendarIpc';
import {
  startCalendarHealthChecks,
  syncMacCalendarTokensAtLaunch,
} from './services/assistant/calendar/calendarService';
import { getMacCalendarAccount } from './services/assistant/calendar/calendarStore';
import { registerHostBridgeHandlers } from './services/hostBridge/ipcHandlers';
import { ensureHostBridgeStarted } from './services/hostBridge/hostBridgeService';
import { ConfidentialService } from './services/inference/confidential/confidentialService';
import { ConfidentialStore } from './services/inference/confidential/confidentialStore';
import { createConfidentialService } from './services/inference/confidential/createConfidentialService';
import { confidentialPoolEnabled } from './services/inference/confidential/featureFlag';
import { registerConfidentialHandlers } from './services/inference/confidential/ipcHandlers';
import { broadcast, getMainWindow, setMainWindowFactory, showMainWindow } from './services/windows';
import { setInferenceChainConfidential } from './services/inference/inferenceChainService';
import { setInferenceRouterPoolSender } from './services/inference/inferenceRouterService';
import { createPoolSender } from './services/inference/confidential/poolSender';
import { SpendLog } from './services/inference/confidential/spendLog';
import { startCirclesNetworkSpike } from './services/circles/networkSpike';
import { startCirclesIfMember } from './services/circles/circlesService';
import { getUsedServices } from './services/circles/usedServicesRuntime';
import { registerCirclesHandlers } from './services/circles/ipcHandlers';
import { ensureAssistantStackOnLaunch } from './services/assistant/AssistantStackService';
import { startLocalLlmWatcher } from './services/onboarding/LocalLlmWatcher';
import { registerExperiments, startExperimentsBeforeWindow } from './experiments';
import { findRunningSibling, refuseToStart } from './siblingBuild';
import { claimSingleInstance } from './singleInstance';
import { failSmokeRun, isSmokeRun } from './smokeExit';
import { runStartupMigrations } from './migrations';
import { recordDataVersion, registerUpdateHandlers, startUpdates } from './services/updates/ipcHandlers';
import { registerWhatsNewHandlers } from './services/whatsNew/ipcHandlers';

registerShutdownHooks();

persistDebugLog('startup', 'main module boot', {
  pid: process.pid,
  ppid: process.ppid,
  ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null,
  argv: process.argv,
});

process.on('exit', (code) => {
  persistDebugLog('startup', 'process.exit', { code });
});
process.on('beforeExit', (code) => {
  persistDebugLog('startup', 'process.beforeExit', { code });
});

// Windows: Squirrel runs the app to create or remove shortcuts on install and uninstall. That
// run only quits; it claims no lock, registers nothing and opens no window.
persistDebugLog('startup', 'electron-squirrel-startup', {
  started: Boolean(started),
  platform: process.platform,
  argv: process.argv,
});
if (started) {
  persistDebugLog('startup', 'quitting due to squirrel startup', {});
  app.quit();
} else {
  boot();
}

function boot(): void {
  app.on('child-process-gone', (_event, details) => {
    persistDebugLog('startup', 'child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: details.name,
      serviceName: details.serviceName,
    });
  });
  app.on('render-process-gone', (_event, _webContents, details) => {
    persistDebugLog('startup', 'render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // Too late for userData: stores read it during import. A packaged build's name reaches userData
  // through productName, which forge.config.ts sets.
  app.setName(APP_NAME);
  setLinuxDesktopName();

  // Windows groups taskbar entries and notifications by this id.
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
  if (process.platform === 'darwin') {
    app.setAsDefaultProtocolClient(INSTANCE_NAME);
  }

  // Packaged only, so a dev build can run beside an installed app.
  const runningSibling = app.isPackaged ? findRunningSibling() : null;

  const isPrimaryInstance =
    !runningSibling &&
    claimSingleInstance(app, () => {
      void showMainWindow().catch((error: unknown) => {
        persistDebugLog('startup', 'second instance could not show the window', serializeError(error));
      });
    });

  const isDevelopment =
    process.env.NODE_ENV === 'development' ||
    process.env.ENVIRONMENT === 'dev' ||
    process.env.ENVIRONMENT === 'development';

  if (isDevelopment && process.stdin) {
    process.stdin.on('end', () => {
      persistDebugLog('startup', 'stdin ended; quitting in development', { appReady: app.isReady() });
      if (app.isReady()) {
        app.quit();
      }
    });
  }

  const store = createConfigStore();

  // Before the services below read the data these change.
  if (isPrimaryInstance) {
    runStartupMigrations();
    recordDataVersion(store, app.getVersion());
  }

  registerAppearanceHandlers(store);
  registerDesktopAgentSettingHandlers(
    store,
    () => void showMainWindow(),
    // The shortcut from any app does what ⌘J does in the page (ADR 0058 §11).
    () => {
      const win = getMainWindow();
      if (win) sendEvent(win.webContents, 'app:menu-command', 'toggle-agent');
    }
  );
  onDesktopAgentChange((on) => {
    const win = getMainWindow();
    if (win) {
      win.webContents.setBackgroundThrottling(!on);
      // Turned off while hidden: bring the window back before its button goes (ADR 0058 §17).
      if (!on && !win.isVisible()) win.show();
    }
    if (!on) closeDesktopAgentWindows();
  });
  registerAppBadgeHandlers();
  registerMediaHandlers();
  registerCallHandlers();
  registerRingAlertHandlers();
  registerUrlHandlers();
  registerBugReportHandlers();
  registerOnboardingHandlers();
  registerCapabilityHandlers();
  registerSetupHandlers();
  registerAssistantStackHandlers();
  registerResourceHandlers();
  registerAddonHandlers();
  registerHermesChatHandlers();
  registerKanbanHandlers();
  registerAgentHandlers();
  registerChannelHandlers();
  registerProjectHandlers();
  registerCodingFolderHandlers();
  registerWritingVoiceHandlers();
  registerWritingCheckHandlers();
  registerHermesVaultHandlers();
  registerCalendarHandlers();
  startCalendarHealthChecks();
  registerHostBridgeHandlers();
  const confidentialService = createConfidentialServiceForApp();
  registerConfidentialHandlers(confidentialService);
  if (confidentialPoolEnabled(process.env, app.isPackaged)) {
    setInferenceChainConfidential(confidentialService);
    setInferenceRouterPoolSender(
      createPoolSender({
        service: confidentialService,
        log: (message, data) => persistDebugLog('confidential', message, data),
        recordSpend: (entry) => confidentialService.recordSpend(entry),
      })
    );
  }
  registerCirclesHandlers();
  registerUpdateHandlers(() => stopStackThen(installUpdate), createAppMenu);
  registerWhatsNewHandlers();
  startLocalLlmWatcher();

  registerExperiments();

  const smokeDeps = {
    exit: (code: number) => app.exit(code),
    log: (message: string, fields: Record<string, unknown>) => {
      persistDebugLog('startup', message, fields);
      console.log(`[smoke] ${message}`, JSON.stringify(fields));
    },
  };

  const createWindow = createMainWindowFactory({ store, isDevelopment, smokeDeps });
  setMainWindowFactory(createWindow);

  async function onAppReady(): Promise<void> {
    if (runningSibling) return refuseToStart(app, runningSibling);
    if (!isPrimaryInstance) return;
    startLagProbe();
    persistDebugLog('startup', 'app ready entered', {
      isPackaged: app.isPackaged,
      isDevelopment,
      cwd: process.cwd(),
      userData: app.getPath('userData'),
      logs: app.getPath('logs'),
      temp: app.getPath('temp'),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath ?? null,
      debugLogPath: getDebugLogPath(),
      version: app.getVersion(),
      locale: app.getLocale(),
    });
    createAppMenu();
    // Not awaited: a slow provider must not hold up startup.
    void confidentialService.refreshLive().catch((error: unknown) => {
      persistDebugLog('confidential', 'refresh failed', { errorName: error instanceof Error ? error.name : typeof error });
    });
    await startUpdates();
    // Older builds kept these secrets in plaintext in boundary-config. Nothing reads them now.
    for (const key of ['apiKey', 'secretToken', 'databaseUrl'] as const) {
      store.delete(key);
    }

    if (process.platform === 'darwin' && app.dock) {
      app.dock.show().catch((error: unknown) => {
        persistDebugLog('startup', 'dock show failed', serializeError(error));
      });
    }

    // Experiments finish their startup before the window opens; a failure quits, as below.
    try {
      await startExperimentsBeforeWindow();

      await createWindow();
      persistDebugLog('startup', 'createWindow returned', {
        hasWindow: Boolean(getMainWindow()),
      });
      // A smoke run checks only that the packaged window loads; it starts nothing that needs a
      // container engine or the network.
      if (isSmokeRun()) return;

      // Host bridge (ADR 0027). The stack's Hermes config step waits for it too.
      void ensureHostBridgeStarted().catch((error) => {
        persistDebugLog('startup', 'host bridge start failed at launch', serializeError(error));
      });
      // The Mac calendar account's agent tokens, which open the bridge's `/calendar` route. The
      // bridge service keeps them for every launch, so a bridge started later (after Stop agent is
      // turned off) gets them too.
      if (getMacCalendarAccount()) void syncMacCalendarTokensAtLaunch();

      void ensureAssistantStackOnLaunch().catch((error) => {
        persistDebugLog('startup', 'assistant stack launch ensure failed', serializeError(error));
      });

      // Circles plan phase 0: runs only when BOUNDARY_CIRCLES_SPIKE is set.
      startCirclesNetworkSpike();
      // Circles start at launch only for someone who belongs to one (ADR 0032).
      startCirclesIfMember();
      // Listeners for services used from a Circle, so their workspaces answer, if only to say the
      // provider is offline (ADR 0048 §11).
      void getUsedServices()
        .startAll()
        .catch((error: unknown) => {
          persistDebugLog('circles', 'used services did not start', { error: error instanceof Error ? error.name : 'unknown' });
        });
    } catch (error) {
      persistDebugLog('startup', 'ready try/catch quitting app (first-launch candidate)', {
        ...serializeError(error),
      });
      console.error('Startup failed before the main window opened:', error);
      if (isSmokeRun()) return failSmokeRun(smokeDeps, error);
      app.quit();
    }
  }

  app.on('ready', () => {
    onAppReady().catch((error: unknown) => {
      persistDebugLog('startup', 'ready handler threw', serializeError(error));
      console.error('Startup failed:', error);
    });
  });

  registerQuitHandlers({ isDevelopment, saveDisplay: () => saveDisplayForQuit(store) });

  app.on('activate', () => {
    // Launching fires this too, and a refused start must not open a window.
    if (!isPrimaryInstance) return;
    persistDebugLog('startup', 'activate', {
      windowCount: BrowserWindow.getAllWindows().length,
    });
    void showMainWindow().catch((error: unknown) => {
      persistDebugLog('startup', 'activate could not show the window', serializeError(error));
    });
  });
}

function createConfidentialServiceForApp(): ConfidentialService {
  return createConfidentialService({
    enabled: confidentialPoolEnabled(process.env, app.isPackaged),
    resourcesDir: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
    makeStore: () => new ConfidentialStore(),
    makeSpendLog: () => new SpendLog(),
    onChange: (state) => broadcast('confidential:state', state),
  });
}
