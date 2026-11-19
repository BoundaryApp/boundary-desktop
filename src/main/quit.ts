import { app, BrowserWindow, dialog } from 'electron';
import { createFileLogger } from '../shared/utils/logger';
import { confirmQuitDuringCall, isCallLive, quitDialogOn } from './callQuit';
import { persistDebugLog, serializeError } from './persistDebugLog';
import { stopExperiments } from './experiments';
import { dockerService } from './services/dockerService';
import { stopBundledMachineIfStarted } from './services/containerRuntime';
import { closeDesktopAgentWindowsForGood } from './services/desktopAgent/desktopAgentWindows';
import { stopHostBridge } from './services/hostBridge/hostBridgeService';
import { stopMacCalendarHelper } from './services/assistant/calendar/macCalendarHelper';
import { withdrawHeldTurnsForQuit } from './services/assistant/hermes/workloadScheduler';
import { announceAssistantStackStopping, stopAssistantStack } from './services/assistant/AssistantStackService';
import { stopCirclesNetworkSpike } from './services/circles/networkSpike';
import { stopCircles } from './services/circles/circlesService';
import { getUsedServices } from './services/circles/usedServicesRuntime';
import { stopInferenceRouter } from './services/inference/inferenceRouterService';
import { quitAndInstallUpdate } from './services/updates/ipcHandlers';
import { getMainWindow } from './services/windows';

const log = createFileLogger(import.meta.url);

/** How long Squirrel gets to take over before Boundary exits; the update then installs on exit. */
const UPDATE_INSTALL_DEADLINE_MS = 30_000;

/** How long an uncaught exception waits for the quit teardown before exiting anyway. */
const FATAL_TEARDOWN_DEADLINE_MS = 5_000;

/** How long the renderer gets to paint the quit screen before teardown starts. */
const QUIT_SCREEN_PAINT_MS = 150;

/** Set by the first `before-quit` (or an update install); the second pass must not preventDefault. */
let quitting = false;

/** Set once the stack has stopped for an update, so the window may close. */
let installingUpdate = false;

let quitTeardown: Promise<Record<string, number>> | null = null;

/** The first quit step. index.ts sets it once the config store exists. */
let saveDisplay: () => unknown = () => undefined;

export const isQuitting = (): boolean => quitting;
export const isInstallingUpdate = (): boolean => installingUpdate;

/**
 * Stop the host bridge and the assistant stack, then the Docker service. Quit and an uncaught
 * exception share it, and it runs once. Resolves with milliseconds per step and never rejects.
 */
export function runQuitTeardown(): Promise<Record<string, number>> {
  quitTeardown ??= (async () => {
    // Milliseconds per quit step, logged on exit so a slow quit names its step.
    const stepMs: Record<string, number> = {};
    // A failed step is logged and the next one still runs, so one throw can't leave the stack up.
    const timed = async (step: string, run: () => unknown) => {
      const startedAt = Date.now();
      try {
        await run();
      } catch (error) {
        persistDebugLog('startup', 'quit step failed', { step, ...serializeError(error) });
      } finally {
        stepMs[step] = Date.now() - startedAt;
      }
    };
    await timed('saveDisplay', saveDisplay);
    // Before the stack stops, so a held send is kept as an unsent message.
    await timed('heldTurns', withdrawHeldTurnsForQuit);
    await timed('hostBridge', stopHostBridge);
    await timed('calendarHelper', stopMacCalendarHelper);
    // Experiments may use Circles, so they stop before it.
    await timed('experiments', stopExperiments);
    await timed('circlesNetwork', stopCirclesNetworkSpike);
    await timed('usedServices', () => getUsedServices().closeAll());
    await timed('circles', stopCircles);
    await timed('inferenceRouter', stopInferenceRouter);
    await timed('assistantStack', stopAssistantStack);
    // After the containers stop, so the VM doesn't outlive the app with its memory reserved.
    await timed('bundledMachine', stopBundledMachineIfStarted);
    await timed('dockerDestroy', () => dockerService.destroy());
    return stepMs;
  })();
  return quitTeardown;
}

/**
 * Process error and signal hooks. An unhandled rejection is logged and the app keeps running.
 * After an uncaught exception main's state is unknown, so it stops the host bridge and the stack
 * (bounded by a deadline) and exits.
 */
export function registerShutdownHooks(): void {
  let fatalExitStarted = false;
  const onProcessError = (kind: 'uncaughtException' | 'unhandledRejection', reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    persistDebugLog('startup', kind, serializeError(error));
    console.error(`Main process ${kind}:`, reason);
    if (kind === 'unhandledRejection' || fatalExitStarted) return;
    fatalExitStarted = true;
    const deadline = new Promise<'deadline'>((resolve) =>
      setTimeout(() => resolve('deadline'), FATAL_TEARDOWN_DEADLINE_MS)
    );
    void Promise.race([runQuitTeardown(), deadline]).then((result) => {
      if (result === 'deadline') {
        persistDebugLog('startup', 'teardown after uncaughtException passed its deadline', {
          deadlineMs: FATAL_TEARDOWN_DEADLINE_MS,
        });
        try {
          dockerService.destroy();
        } catch (e) {
          console.warn('dockerService.destroy after uncaughtException:', e);
        }
      } else {
        persistDebugLog('startup', 'teardown after uncaughtException done', { stepMs: result });
      }
      process.exit(1);
    });
  };
  process.on('uncaughtException', (err) => onProcessError('uncaughtException', err));
  process.on('unhandledRejection', (reason) => onProcessError('unhandledRejection', reason));

  if (process.platform !== 'win32') {
    let signalShutdownStarted = false;
    const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
      persistDebugLog('startup', `signal ${signal}`, { appReady: app.isReady() });
      if (signalShutdownStarted) {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      }
      signalShutdownStarted = true;
      if (app.isReady()) {
        app.quit();
        return;
      }
      try {
        dockerService.destroy();
      } catch (e) {
        console.warn(`dockerService.destroy after ${signal}:`, e);
      }
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
  }
}

/**
 * Show the quit screen, stop the stack, then finish. `autoUpdater.quitAndInstall()` closes the
 * windows before `before-quit` fires, so the update path calls this first and `before-quit`
 * passes through.
 */
export function stopStackThen(finish: () => void): void {
  if (quitting) return;
  quitting = true;
  closeDesktopAgentWindowsForGood();

  // Show quit overlay before any teardown so progress events have a live window.
  try {
    announceAssistantStackStopping();
  } catch (error) {
    log('Error announcing assistant stack stop:', error);
  }
  getMainWindow()?.show();

  void (async () => {
    await new Promise((r) => setTimeout(r, QUIT_SCREEN_PAINT_MS));
    const stepMs = await runQuitTeardown();
    persistDebugLog('startup', 'before-quit cleanup done', { stepMs });
    // app.quit() after preventDefault can close windows without exiting on macOS.
    finish();
  })();
}

/** Stop the stack, then hand over to Squirrel to install the downloaded update. */
export function installUpdate(): void {
  installingUpdate = true;
  // quitAndInstall waits for every window to close.
  closeDesktopAgentWindowsForGood();
  setTimeout(() => {
    persistDebugLog('updates', 'quitAndInstall did not finish, exiting', {});
    app.exit(0);
  }, UPDATE_INSTALL_DEADLINE_MS);
  quitAndInstallUpdate();
}

/** The app's quit path: `window-all-closed`, `before-quit` and `quit`. */
export function registerQuitHandlers(options: { isDevelopment: boolean; saveDisplay: () => unknown }): void {
  const { isDevelopment } = options;
  saveDisplay = options.saveDisplay;

  // Quit when all windows are closed, except on macOS, where the app and its menu bar stay
  // until Cmd+Q.
  app.on('window-all-closed', () => {
    persistDebugLog('startup', 'window-all-closed', {
      platform: process.platform,
      isDevelopment,
      isElectronQuitAfterShutdown: quitting,
      willQuit: process.platform !== 'darwin' || isDevelopment || quitting,
      windowCount: BrowserWindow.getAllWindows().length,
    });
    // In dev, quit on macOS too so electron-forge child exit releases the terminal.
    // Also finish an in-progress Cmd+Q: preventDefault + app.quit() otherwise closes
    // windows and leaves a Dock zombie that the next `open` activates.
    // quitAndInstall quits by itself once the windows have closed.
    if (installingUpdate) return;
    if (process.platform !== 'darwin' || isDevelopment || quitting) {
      app.quit();
    }
  });

  app.on('before-quit', (e) => {
    const win = getMainWindow();
    persistDebugLog('startup', 'before-quit', {
      isElectronQuitAfterShutdown: quitting,
      hasMainWindow: Boolean(win),
    });
    if (quitting) return;
    e.preventDefault();
    // With no call the quit goes on in this tick; during one the dialog comes first.
    if (!isCallLive()) {
      stopStackThen(() => app.exit(0));
      return;
    }
    const ask = quitDialogOn(
      win,
      (parent, dialogOptions) => dialog.showMessageBox(parent, dialogOptions),
      (dialogOptions) => dialog.showMessageBox(dialogOptions)
    );
    void confirmQuitDuringCall(ask).then((quit) => {
      if (quit) stopStackThen(() => app.exit(0));
    });
  });

  app.on('quit', () => {
    persistDebugLog('startup', 'quit', {});
  });
}
