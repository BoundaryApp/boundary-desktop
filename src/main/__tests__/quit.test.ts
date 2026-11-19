import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: any[]) => any;

const h = vi.hoisted(() => {
  const order: string[] = [];
  const step = (name: string) => vi.fn(async () => void order.push(name));
  return {
    order,
    appHandlers: {} as Record<string, Handler>,
    processHandlers: {} as Record<string, Handler>,
    appReady: true,
    callLive: false,
    mainWindow: undefined as undefined | { show: ReturnType<typeof vi.fn> },
    // Spies live here, not in the mock factories: loadQuit resets modules, which re-runs them.
    app: { quit: vi.fn(), exit: vi.fn() },
    persistDebugLog: vi.fn(),
    closeDesktopAgentWindowsForGood: vi.fn(),
    quitAndInstallUpdate: vi.fn(),
    confirmQuitDuringCall: vi.fn(async () => true),
    steps: {
      heldTurns: step('heldTurns'),
      hostBridge: step('hostBridge'),
      calendarHelper: step('calendarHelper'),
      experiments: step('experiments'),
      circlesNetwork: step('circlesNetwork'),
      usedServices: step('usedServices'),
      circles: step('circles'),
      inferenceRouter: step('inferenceRouter'),
      assistantStack: step('assistantStack'),
      bundledMachine: step('bundledMachine'),
      dockerDestroy: vi.fn(() => void order.push('dockerDestroy')),
    },
  };
});

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, fn: Handler) => {
      h.appHandlers[event] = fn;
    }),
    quit: h.app.quit,
    exit: h.app.exit,
    isReady: () => h.appReady,
  },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('../persistDebugLog', () => ({
  persistDebugLog: h.persistDebugLog,
  serializeError: (error: unknown) => ({ message: String(error) }),
}));
vi.mock('../callQuit', () => ({
  isCallLive: () => h.callLive,
  quitDialogOn: vi.fn(() => vi.fn()),
  confirmQuitDuringCall: h.confirmQuitDuringCall,
}));
vi.mock('../services/windows', () => ({ getMainWindow: () => h.mainWindow }));
vi.mock('../services/desktopAgent/desktopAgentWindows', () => ({ closeDesktopAgentWindowsForGood: h.closeDesktopAgentWindowsForGood }));
vi.mock('../services/updates/ipcHandlers', () => ({ quitAndInstallUpdate: h.quitAndInstallUpdate }));
vi.mock('../services/assistant/AssistantStackService', () => ({
  announceAssistantStackStopping: vi.fn(),
  stopAssistantStack: h.steps.assistantStack,
}));
vi.mock('../services/assistant/hermes/workloadScheduler', () => ({ withdrawHeldTurnsForQuit: h.steps.heldTurns }));
vi.mock('../services/hostBridge/hostBridgeService', () => ({ stopHostBridge: h.steps.hostBridge }));
vi.mock('../services/assistant/calendar/macCalendarHelper', () => ({ stopMacCalendarHelper: h.steps.calendarHelper }));
vi.mock('../experiments', () => ({ stopExperiments: h.steps.experiments }));
vi.mock('../services/circles/networkSpike', () => ({ stopCirclesNetworkSpike: h.steps.circlesNetwork }));
vi.mock('../services/circles/usedServicesRuntime', () => ({
  getUsedServices: () => ({ closeAll: h.steps.usedServices }),
}));
vi.mock('../services/circles/circlesService', () => ({ stopCircles: h.steps.circles }));
vi.mock('../services/inference/inferenceRouterService', () => ({ stopInferenceRouter: h.steps.inferenceRouter }));
vi.mock('../services/containerRuntime', () => ({ stopBundledMachineIfStarted: h.steps.bundledMachine }));
vi.mock('../services/dockerService', () => ({ dockerService: { destroy: h.steps.dockerDestroy } }));


const realPlatform = process.platform;
let exitSpy: ReturnType<typeof vi.spyOn>;

/** A fresh quit module (its flags start unset), with process listeners captured, not installed. */
async function loadQuit(platform: NodeJS.Platform = 'darwin') {
  vi.resetModules();
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  const quit = await import('../quit');
  const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, fn: Handler) => {
    h.processHandlers[event] = fn;
    return process;
  }) as typeof process.on);
  quit.registerShutdownHooks();
  onSpy.mockRestore();
  return quit;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.order.length = 0;
  h.appHandlers = {};
  h.processHandlers = {};
  h.appReady = true;
  h.callLive = false;
  h.mainWindow = { show: vi.fn() };
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): void => undefined) as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.useRealTimers();
});

describe('runQuitTeardown', () => {
  it('saves the display first and stops everything in order, once', async () => {
    const quit = await loadQuit();
    const saveDisplay = vi.fn(() => void h.order.push('saveDisplay'));
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay });
    const stepMs = await quit.runQuitTeardown();
    await quit.runQuitTeardown();
    expect(h.order).toEqual([
      'saveDisplay',
      'heldTurns',
      'hostBridge',
      'calendarHelper',
      'experiments',
      'circlesNetwork',
      'usedServices',
      'circles',
      'inferenceRouter',
      'assistantStack',
      'bundledMachine',
      'dockerDestroy',
    ]);
    expect(Object.keys(stepMs)).toHaveLength(12);
  });

  it('logs a failed step and still runs the rest', async () => {
    const quit = await loadQuit();
    h.steps.experiments.mockRejectedValueOnce(new Error('experiment did not stop'));
    await quit.runQuitTeardown();
    expect(h.persistDebugLog).toHaveBeenCalledWith(
      'startup',
      'quit step failed',
      expect.objectContaining({ step: 'experiments' })
    );
    expect(h.steps.assistantStack).toHaveBeenCalledTimes(1);
    expect(h.steps.bundledMachine).toHaveBeenCalledTimes(1);
    expect(h.steps.dockerDestroy).toHaveBeenCalled();
  });
});

describe('process error handlers (G15-11)', () => {
  it('logs an unhandled rejection and keeps running', async () => {
    await loadQuit();
    h.processHandlers.unhandledRejection(new Error('stray promise'));
    await vi.runAllTimersAsync();
    expect(h.persistDebugLog).toHaveBeenCalledWith('startup', 'unhandledRejection', expect.anything());
    expect(exitSpy).not.toHaveBeenCalled();
    expect(h.steps.assistantStack).not.toHaveBeenCalled();
  });

  it('runs the quit teardown on an uncaught exception, then exits', async () => {
    await loadQuit();
    h.processHandlers.uncaughtException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.steps.hostBridge).toHaveBeenCalledTimes(1);
    expect(h.steps.assistantStack).toHaveBeenCalledTimes(1);
    expect(h.steps.dockerDestroy).toHaveBeenCalled();
  });

  it('exits at the deadline when teardown hangs', async () => {
    await loadQuit();
    h.steps.assistantStack.mockImplementationOnce(() => new Promise(() => undefined));
    h.processHandlers.uncaughtException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(exitSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(h.steps.dockerDestroy).toHaveBeenCalled();
  });

  it('quits the app on SIGTERM once ready, and exits on a second signal', async () => {
    await loadQuit();
    h.processHandlers.SIGTERM();
    expect(h.app.quit).toHaveBeenCalledOnce();
    h.processHandlers.SIGTERM();
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('installs no signal handlers on Windows', async () => {
    await loadQuit('win32');
    expect(h.processHandlers.SIGINT).toBeUndefined();
  });
});

describe('before-quit', () => {
  it('holds the quit, shows the quit screen, stops the stack, then exits', async () => {
    const quit = await loadQuit();
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay: vi.fn() });
    const event = { preventDefault: vi.fn() };
    h.appHandlers['before-quit'](event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(quit.isQuitting()).toBe(true);
    expect(h.closeDesktopAgentWindowsForGood).toHaveBeenCalled();
    expect(h.mainWindow!.show).toHaveBeenCalled();
    expect(h.steps.assistantStack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.steps.assistantStack).toHaveBeenCalledOnce();
    expect(h.app.exit).toHaveBeenCalledWith(0);
    // The second pass, from app.exit, goes through.
    const second = { preventDefault: vi.fn() };
    h.appHandlers['before-quit'](second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('asks first during a call, and stays open on No', async () => {
    const quit = await loadQuit();
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay: vi.fn() });
    h.callLive = true;
    h.confirmQuitDuringCall.mockResolvedValueOnce(false);
    h.appHandlers['before-quit']({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.confirmQuitDuringCall).toHaveBeenCalled();
    expect(quit.isQuitting()).toBe(false);
    expect(h.steps.assistantStack).not.toHaveBeenCalled();
  });
});

describe('window-all-closed', () => {
  it('keeps the app running on macOS outside development', async () => {
    const quit = await loadQuit('darwin');
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay: vi.fn() });
    h.appHandlers['window-all-closed']();
    expect(h.app.quit).not.toHaveBeenCalled();
  });

  it('quits elsewhere, and in development', async () => {
    let quit = await loadQuit('win32');
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay: vi.fn() });
    h.appHandlers['window-all-closed']();
    quit = await loadQuit('darwin');
    quit.registerQuitHandlers({ isDevelopment: true, saveDisplay: vi.fn() });
    h.appHandlers['window-all-closed']();
    expect(h.app.quit).toHaveBeenCalledTimes(2);
  });
});

describe('installing an update', () => {
  it('stops the stack, then hands over to Squirrel', async () => {
    const quit = await loadQuit();
    quit.registerQuitHandlers({ isDevelopment: false, saveDisplay: vi.fn() });
    quit.stopStackThen(quit.installUpdate);
    expect(h.quitAndInstallUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.steps.assistantStack).toHaveBeenCalledOnce();
    expect(h.quitAndInstallUpdate).toHaveBeenCalledOnce();
    expect(quit.isInstallingUpdate()).toBe(true);
    // quitAndInstall quits by itself once the windows have closed.
    h.appHandlers['window-all-closed']();
    expect(h.app.quit).not.toHaveBeenCalled();
  });

  it('exits if Squirrel never takes over', async () => {
    const quit = await loadQuit();
    quit.installUpdate();
    expect(h.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.app.exit).toHaveBeenCalledWith(0);
  });
});
