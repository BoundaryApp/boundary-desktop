import { EventEmitter } from 'node:events';
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fake utilityProcess child that answers `start` with `ready` and exits on `stop`. */
class FakeChild extends EventEmitter {
  postMessage = vi.fn((message: { type: string }) => {
    if (message.type === 'start') setImmediate(() => this.emit('message', { type: 'ready', mcpPort: 1, browserPort: 2 }));
    if (message.type === 'stop') setImmediate(() => this.emit('exit', 0));
  });
  kill = vi.fn(() => this.emit('exit', 0));
}

let lastChild: FakeChild | null = null;
const fork = vi.fn(() => (lastChild = new FakeChild()));
const sent: Array<[string, unknown]> = [];

vi.mock('electron', () => {
  return {
    app: { getPath: () => os.tmpdir() },
    // Keychain unavailable: tokens live for the test only.
    safeStorage: { isAsyncEncryptionAvailable: async () => false },
    utilityProcess: { fork },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => sent.push([channel, payload]) } }],
    },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    clipboard: {},
    dialog: {},
    shell: {},
  };
});

let storedClients = 0;
vi.mock('../hostBridgeStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hostBridgeStore')>()),
  getExpectedHermesClients: () => storedClients,
  setExpectedHermesClients: (count: number) => {
    storedClients = count;
  },
}));

beforeEach(() => {
  vi.resetModules();
  fork.mockClear();
  sent.length = 0;
  storedClients = 0;
});

describe('host bridge lifecycle', () => {
  it('starts once and shares the startup', async () => {
    const service = await import('../hostBridgeService');
    const [a, b] = await Promise.all([service.ensureHostBridgeStarted(), service.ensureHostBridgeStarted()]);
    expect(a).toBe(b);
    expect(fork).toHaveBeenCalledTimes(1);
    await service.stopHostBridge();
  });

  it('never starts again once Boundary is quitting', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    await service.stopHostBridge();
    await expect(service.ensureHostBridgeStarted()).rejects.toThrow(/quitting/);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('answers a status poll without starting the bridge', async () => {
    const service = await import('../hostBridgeService');
    const state = await service.getBoundaryBrowserState();
    expect(state.running).toBe(false);
    expect(fork).not.toHaveBeenCalled();
  });

  it('says connected once as many Hermes clients as last time have listed the tools', async () => {
    storedClients = 2;
    const service = await import('../hostBridgeService');
    expect(service.getHostToolsState()).toBe('off');
    await service.ensureHostBridgeStarted();
    expect(service.getHostToolsState()).toBe('waiting');
    lastChild?.emit('message', { type: 'hermes-clients', count: 1 });
    expect(service.getHostToolsState()).toBe('waiting');
    lastChild?.emit('message', { type: 'hermes-clients', count: 2 });
    expect(service.getHostToolsState()).toBe('connected');
    await service.stopHostBridge();
    expect(service.getHostToolsState()).toBe('off');
    expect(sent.filter(([channel]) => channel === 'host-bridge:tools-state').map(([, state]) => state)).toEqual([
      'waiting',
      'connected',
      'off',
    ]);
  });

  it('settles after Hermes has had its retry, and remembers the count for next time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const service = await import('../hostBridgeService');
      // The fake child answers on setImmediate, which stays real.
      await service.ensureHostBridgeStarted();
      lastChild?.emit('message', { type: 'hermes-clients', count: 3 });
      expect(service.getHostToolsState()).toBe('waiting');
      expect(storedClients).toBe(3);
      await vi.advanceTimersByTimeAsync(330_000);
      expect(service.getHostToolsState()).toBe('connected');
      await service.stopHostBridge();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles 30 s after the stack accepts a wake, instead of waiting out the parked retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const service = await import('../hostBridgeService');
      await service.ensureHostBridgeStarted();
      lastChild?.emit('message', { type: 'hermes-clients', count: 4 });
      service.hostBridgeWakeAccepted();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(service.getHostToolsState()).toBe('waiting');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(service.getHostToolsState()).toBe('connected');
      expect(storedClients).toBe(4);
      await service.stopHostBridge();
    } finally {
      vi.useRealTimers();
    }
  });
});
