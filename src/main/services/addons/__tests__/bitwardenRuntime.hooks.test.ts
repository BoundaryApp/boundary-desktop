import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlainOutcome } from '../addonScript';

const follow = vi.hoisted(() => vi.fn(async () => {}));
const runPlainOnStack = vi.hoisted(() => vi.fn());
const composeOnStack = vi.hoisted(() => vi.fn(async (args: string[], _options?: { profiles?: string[]; timeoutMs?: number }) => (args.at(-1) === 'hermes' ? 'h'.repeat(64) : 'b'.repeat(64))));
const cliOnStack = vi.hoisted(() => vi.fn(async () => `container:${'h'.repeat(64)}`));
const state = vi.hoisted(() => ({ root: '/stack' as string | null, offered: true, enabled: true }));
const persistDebugLog = vi.hoisted(() => vi.fn());
const stackRoot = vi.hoisted(() => ({ dir: '' }));
const electronApp = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    on: (event: string, listener: () => void): void => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener),
    off: (event: string, listener: () => void): void => void listeners.get(event)?.delete(listener),
    emit: (event: string): void => [...(listeners.get(event) ?? [])].forEach((listener) => listener()),
  };
});

vi.mock('electron', () => ({ app: electronApp }));
vi.mock('../bitwardenFollowHermes', () => ({ createHermesFollower: () => ({ follow }) }));
vi.mock('../stackScripts', () => ({
  runOnStack: vi.fn(),
  runJsonOnStack: vi.fn(),
  runPlainOnStack,
  composeOnStack,
  cliOnStack,
  // The service reads BITWARDEN_ENABLED from this root's .env itself, past the mock below.
  stackPaths: () => ({ root: stackRoot.dir, dataRoot: stackRoot.dir }),
}));
vi.mock('../../assistant/resolveAssistantRoot', () => ({ tryResolveAssistantRoot: () => ({ root: state.root }) }));
vi.mock('../bitwardenAddon', async () => ({
  ...(await vi.importActual<object>('../bitwardenAddon')),
  bitwardenOffered: () => state.offered,
  readBitwardenEnabled: () => state.enabled,
}));
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog }));

import { notifyHermesReplaced, runBeforeStackUp } from '../../assistant/hermesLifecycle';
import { BROKER_POLL_MS } from '../bitwardenBrokerWatch';
import { checkBrokerNamespace, registerBitwardenStackHooks } from '../bitwardenRuntime';

const ok: PlainOutcome = { code: 0, stdout: '', stderrTail: [] };

/** Lets the fire-and-forget hermes-replaced listener finish. */
const settle = () => vi.waitFor(() => expect(follow).toHaveBeenCalled());

let unregister: () => void;

beforeEach(() => {
  follow.mockClear();
  runPlainOnStack.mockReset().mockResolvedValue(ok);
  persistDebugLog.mockReset();
  state.root = '/stack';
  state.offered = true;
  state.enabled = true;
  unregister = registerBitwardenStackHooks();
});

afterEach(() => unregister());

describe('registerBitwardenStackHooks', () => {
  it('passes each hermes restart reason to the follower', async () => {
    notifyHermesReplaced('web-search');
    await settle();
    expect(follow.mock.calls).toEqual([['web-search']]);
    expect(runPlainOnStack).not.toHaveBeenCalled();
  });

  describe('runs pre-up before up only while Bitwarden is active', () => {
    it('runs vault.sh pre-up while active', async () => {
      await runBeforeStackUp();
      expect(runPlainOnStack).toHaveBeenCalledTimes(1);
      expect(runPlainOnStack).toHaveBeenCalledWith('vault.sh', ['pre-up'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    });

    it.each([
      ['not offered', () => { state.offered = false; }],
      ['switched off', () => { state.enabled = false; }],
      ['no stack root', () => { state.root = null; }],
    ])('does not call vault.sh when Bitwarden is %s', async (_name, turnOff) => {
      turnOff();
      await runBeforeStackUp();
      expect(runPlainOnStack).not.toHaveBeenCalled();
    });
  });

  it('fails the start with pre-up’s message', async () => {
    runPlainOnStack.mockResolvedValue({ code: 2, stdout: 'secret', stderrTail: ['secret'] });
    await expect(runBeforeStackUp()).rejects.toThrow('vault.sh pre-up exited 2');
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('secret');
  });

  describe('after a start', () => {
    it('runs up-hook, then follow-hermes', async () => {
      notifyHermesReplaced('start');
      await settle();
      expect(runPlainOnStack).toHaveBeenCalledWith('vault.sh', ['up-hook'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
      expect(runPlainOnStack.mock.invocationCallOrder[0]).toBeLessThan(follow.mock.invocationCallOrder[0]);
      expect(follow.mock.calls).toEqual([['start']]);
    });

    it('does not run up-hook for other reasons', async () => {
      notifyHermesReplaced('addon-reload');
      await settle();
      expect(runPlainOnStack).not.toHaveBeenCalled();
    });

    it('does not run up-hook while Bitwarden is off', async () => {
      state.enabled = false;
      notifyHermesReplaced('start');
      await settle();
      expect(runPlainOnStack).not.toHaveBeenCalled();
    });

    it.each([
      ['exits non-zero', () => runPlainOnStack.mockResolvedValue({ code: 1, stdout: 'secret', stderrTail: ['secret'] }), { code: 1 }],
      ['rejects', () => runPlainOnStack.mockRejectedValue(new TypeError('secret')), { error: 'TypeError' }],
    ])('up-hook that %s is logged as metadata and follow-hermes still runs', async (_name, arrange, logged) => {
      arrange();
      notifyHermesReplaced('start');
      await settle();
      expect(follow.mock.calls).toEqual([['start']]);
      expect(persistDebugLog).toHaveBeenCalledWith('addons', 'bitwarden up-hook', expect.objectContaining(logged));
      expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('secret');
    });
  });
});

describe('checkBrokerNamespace', () => {
  beforeEach(() => {
    composeOnStack.mockClear();
    cliOnStack.mockClear();
  });

  it('reads the namespace through compose with the bitwarden profile while Bitwarden is active', async () => {
    expect(await checkBrokerNamespace()).toEqual({ ok: true, matches: true });
    expect(composeOnStack.mock.calls.map((c) => [c[0].at(-1), c[1]])).toEqual([
      ['bitwarden-broker', expect.objectContaining({ profiles: ['bitwarden'] })],
      ['hermes', expect.objectContaining({ profiles: ['bitwarden'] })],
    ]);
  });

  it('reads nothing while Bitwarden is off or not offered', async () => {
    state.enabled = false;
    expect(await checkBrokerNamespace()).toEqual({ ok: false, reason: 'inactive' });
    state.enabled = true;
    state.offered = false;
    expect(await checkBrokerNamespace()).toEqual({ ok: false, reason: 'inactive' });
    expect(composeOnStack).not.toHaveBeenCalled();
    expect(cliOnStack).not.toHaveBeenCalled();
  });
});

describe('a hermes recreated outside Boundary', () => {
  beforeAll(() => {
    stackRoot.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitwarden-watch-'));
    fs.writeFileSync(path.join(stackRoot.dir, '.env'), 'BITWARDEN_ENABLED=1\n');
  });
  afterAll(() => fs.rmSync(stackRoot.dir, { recursive: true, force: true }));

  /** The service is shared across tests, so each test starts well past the last one's repair limit. */
  let epoch = Date.UTC(2026, 10, 13);
  const stale = () => cliOnStack.mockResolvedValue(`container:${'x'.repeat(64)}`);

  beforeEach(() => {
    unregister();
    vi.useFakeTimers();
    epoch += 3_600_000;
    vi.setSystemTime(epoch);
    cliOnStack.mockReset().mockResolvedValue(`container:${'h'.repeat(64)}`);
    composeOnStack.mockClear();
    unregister = registerBitwardenStackHooks();
  });

  afterEach(() => {
    unregister();
    vi.useRealTimers();
  });

  it('the five-minute poll moves a stranded broker into the new hermes', async () => {
    stale();
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(follow.mock.calls).toEqual([['broker-down']]);
    expect(persistDebugLog).toHaveBeenCalledWith('addons', 'bitwarden repair', expect.objectContaining({ reason: 'namespace', trigger: 'poll' }));
  });

  it('window focus moves it at once', async () => {
    stale();
    electronApp.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(follow.mock.calls).toEqual([['broker-down']]);
  });

  it('a broker in hermes\'s namespace is left alone', async () => {
    electronApp.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS);
    expect(cliOnStack).toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  });

  it('runs no container command while Bitwarden is off', async () => {
    state.enabled = false;
    stale();
    electronApp.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS * 2);
    expect(composeOnStack).not.toHaveBeenCalled();
    expect(follow).not.toHaveBeenCalled();
  });

  it('stops watching when unregistered', async () => {
    unregister();
    stale();
    electronApp.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(BROKER_POLL_MS * 2);
    expect(composeOnStack).not.toHaveBeenCalled();
    expect(electronApp.listeners.get('browser-window-focus')?.size ?? 0).toBe(0);
  });
});
