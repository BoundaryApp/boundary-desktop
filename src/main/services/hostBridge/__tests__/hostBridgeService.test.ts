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
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) } }],
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
let agentStopped = false;
vi.mock('../hostBridgeStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hostBridgeStore')>()),
  getExpectedHermesClients: () => storedClients,
  setExpectedHermesClients: (count: number) => {
    storedClients = count;
  },
  isHostBridgeAgentStopped: () => agentStopped,
  setHostBridgeAgentStopped: (stopped: boolean) => {
    agentStopped = stopped;
  },
}));

const provisionHermes = vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({ success: true }));

/** The tokens a fake child was started with. */
const startTokens = (child: FakeChild | null) => {
  const start = child?.postMessage.mock.calls.map(([message]) => message).find((message) => message.type === 'start');
  const { mcpToken, browserToken } = start as unknown as { mcpToken: string; browserToken: string };
  return { mcpToken, browserToken };
};

const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  vi.resetModules();
  fork.mockClear();
  provisionHermes.mockClear();
  provisionHermes.mockResolvedValue({ success: true });
  sent.length = 0;
  storedClients = 0;
  agentStopped = false;
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

  it('keeps restarting a bridge that crashes after healthy runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const service = await import('../hostBridgeService');
      await service.ensureHostBridgeStarted();
      for (let crash = 1; crash <= 4; crash++) {
        await vi.advanceTimersByTimeAsync(61_000);
        lastChild?.emit('exit', 1);
        // A restart after a healthy run waits the first back-off, 1 s.
        await vi.advanceTimersByTimeAsync(1_000);
        await waitFor(() => fork.mock.calls.length === crash + 1);
        expect(fork).toHaveBeenCalledTimes(crash + 1);
        await waitFor(() => service.getHostToolsState() === 'waiting');
      }
      await service.stopHostBridge();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a pending request at once when the bridge exits', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    const started = Date.now();
    const state = service.getBoundaryBrowserState();
    lastChild?.emit('exit', 1);
    expect((await state).running).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
    await service.stopHostBridge();
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

  it('settles once Hermes has had its 15 s parked retry, and remembers the count for next time', async () => {
    storedClients = 4;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const service = await import('../hostBridgeService');
      // The fake child answers on setImmediate, which stays real.
      await service.ensureHostBridgeStarted();
      // Hermes may still be starting: no settle until a first client shows up.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(service.getHostToolsState()).toBe('waiting');
      lastChild?.emit('message', { type: 'hermes-clients', count: 3 });
      expect(service.getHostToolsState()).toBe('waiting');
      await vi.advanceTimersByTimeAsync(44_000);
      expect(service.getHostToolsState()).toBe('waiting');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(service.getHostToolsState()).toBe('connected');
      expect(storedClients).toBe(3);
      await service.stopHostBridge();
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers the live client count, not every session a re-initializing client opened', async () => {
    storedClients = 1;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const service = await import('../hostBridgeService');
      await service.ensureHostBridgeStarted();
      expect(lastChild?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'start', sessionIdleMs: 35_000 }));
      lastChild?.emit('message', { type: 'hermes-clients', count: 1 });
      expect(service.getHostToolsState()).toBe('connected');
      // Hermes re-initializes: the new session overlaps the old one until it expires.
      lastChild?.emit('message', { type: 'hermes-clients', count: 2 });
      lastChild?.emit('message', { type: 'hermes-clients', count: 1 });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(storedClients).toBe(1);
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

describe('Stop agent', () => {
  it('ends the bridge, answers calls in flight, and keeps it from starting', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    const child = lastChild;
    expect(await service.stopHostBridgeAgent(provisionHermes)).toEqual({ stopped: true });
    expect(child?.postMessage).toHaveBeenCalledWith({ type: 'stop', reason: expect.stringMatching(/Computer access is stopped/) });
    expect(service.getHostToolsState()).toBe('stopped');
    expect(sent.filter(([channel]) => channel === 'host-bridge:tools-state').at(-1)).toEqual(['host-bridge:tools-state', 'stopped']);
    await expect(service.ensureHostBridgeStarted()).rejects.toThrow(/Computer access is stopped/);
    await expect(service.openBoundaryBrowser()).rejects.toThrow(/Computer access is stopped/);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  it('stays stopped on the next launch until access is turned back on', async () => {
    agentStopped = true;
    const service = await import('../hostBridgeService');
    await expect(service.ensureHostBridgeStarted()).rejects.toThrow(/stopped/);
    expect(fork).not.toHaveBeenCalled();
    expect(service.getHostBridgeAgentState()).toEqual({ stopped: true });
    expect(service.getHostToolsState()).toBe('stopped');

    expect(await service.resumeHostBridgeAgent(provisionHermes)).toEqual({ stopped: false });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(service.getHostToolsState()).toBe('waiting');
    await service.stopHostBridge();
  });

  it('leaves stopped when access is turned back on, even if the bridge then fails to start', async () => {
    agentStopped = true;
    const service = await import('../hostBridgeService');
    expect(service.getHostToolsState()).toBe('stopped');
    fork.mockImplementationOnce(() => {
      throw new Error('no utility process');
    });
    const state = await service.resumeHostBridgeAgent(provisionHermes);
    expect(state.error).toMatch(/no utility process/);
    expect(service.getHostToolsState()).toBe('off');
    expect(sent.filter(([channel]) => channel === 'host-bridge:tools-state').at(-1)).toEqual(['host-bridge:tools-state', 'off']);
  });

  it('refuses a tool call that reaches main after the stop', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    agentStopped = true;
    lastChild?.emit('message', { type: 'tool-call', id: 7, name: 'clipboard_read', args: {} });
    expect(lastChild?.postMessage).toHaveBeenCalledWith({
      type: 'tool-result',
      id: 7,
      result: { content: [{ type: 'text', text: expect.stringMatching(/stopped/) }], isError: true },
    });
    await service.stopHostBridge();
  });
});

describe('token rotation', () => {
  it('rotates both tokens on Stop agent and gives Hermes the new ones while access is off', async () => {
    const service = await import('../hostBridgeService');
    const store = await import('../hostBridgeStore');
    await service.ensureHostBridgeStarted();
    const old = startTokens(lastChild);
    await service.stopHostBridgeAgent(provisionHermes);
    expect(provisionHermes).toHaveBeenCalledTimes(1);
    expect(await store.ensureHostBridgeToken('mcp')).not.toBe(old.mcpToken);
    expect(await store.ensureHostBridgeToken('browser')).not.toBe(old.browserToken);
  });

  it('turns access back on with a fresh bridge on the new tokens, then provisions and wakes Hermes', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    const old = startTokens(lastChild);
    await service.stopHostBridgeAgent(provisionHermes);
    provisionHermes.mockClear();

    expect(await service.resumeHostBridgeAgent(provisionHermes)).toEqual({ stopped: false });
    expect(fork).toHaveBeenCalledTimes(2);
    const fresh = startTokens(lastChild);
    expect(fresh.mcpToken).not.toBe(old.mcpToken);
    expect(fresh.browserToken).not.toBe(old.browserToken);
    expect(provisionHermes).toHaveBeenCalledTimes(1);
    await service.stopHostBridge();
  });

  it('says so when access is back on but Hermes did not get the tokens', async () => {
    agentStopped = true;
    provisionHermes.mockResolvedValueOnce({ success: false, error: 'No configured LLM connection to apply.' });
    const service = await import('../hostBridgeService');
    expect(await service.resumeHostBridgeAgent(provisionHermes)).toEqual({
      stopped: false,
      hermesError: 'No configured LLM connection to apply.',
    });
    await service.stopHostBridge();
  });

  it('replaces the running bridge with one on new tokens, then re-provisions Hermes', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    const oldChild = lastChild;
    const old = startTokens(oldChild);
    const order: string[] = [];
    provisionHermes.mockImplementationOnce(async () => {
      order.push(`provision after ${fork.mock.calls.length} forks`);
      return { success: true };
    });

    expect(await service.rotateHostBridgeAgentTokens(provisionHermes)).toEqual({ success: true });
    expect(oldChild?.postMessage).toHaveBeenCalledWith({ type: 'stop', reason: expect.stringMatching(/new tokens/) });
    expect(lastChild).not.toBe(oldChild);
    const fresh = startTokens(lastChild);
    expect(fresh.mcpToken).not.toBe(old.mcpToken);
    expect(fresh.browserToken).not.toBe(old.browserToken);
    expect(order).toEqual(['provision after 2 forks']);
    expect(service.getHostToolsState()).toBe('waiting');
    await service.stopHostBridge();
  });

  it('reports a Hermes that did not take the new tokens', async () => {
    provisionHermes.mockResolvedValueOnce({ success: false, error: 'Assistant stack is not ready.' });
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    expect(await service.rotateHostBridgeAgentTokens(provisionHermes)).toEqual({
      success: false,
      error: 'Hermes didn’t get the new tokens: Assistant stack is not ready.',
    });
    await service.stopHostBridge();
  });

  it('reports a bridge that did not start on the new tokens, and leaves Hermes alone', async () => {
    const service = await import('../hostBridgeService');
    await service.ensureHostBridgeStarted();
    fork.mockImplementationOnce(() => {
      const child = new FakeChild();
      child.postMessage.mockImplementation((message: { type: string }) => {
        if (message.type === 'start') setImmediate(() => child.emit('message', { type: 'start-failed', error: 'port in use' }));
      });
      return (lastChild = child);
    });
    const result = await service.rotateHostBridgeAgentTokens(provisionHermes);
    expect(result).toEqual({ success: false, error: expect.stringMatching(/tools didn’t start: .*port in use/) });
    expect(provisionHermes).not.toHaveBeenCalled();
    lastChild?.kill();
    await service.stopHostBridge();
  });

  it('while access is stopped, rotates and re-provisions Hermes without starting a bridge', async () => {
    agentStopped = true;
    const service = await import('../hostBridgeService');
    expect(await service.rotateHostBridgeAgentTokens(provisionHermes)).toEqual({ success: true });
    expect(fork).not.toHaveBeenCalled();
    expect(provisionHermes).toHaveBeenCalledTimes(1);
  });
});
