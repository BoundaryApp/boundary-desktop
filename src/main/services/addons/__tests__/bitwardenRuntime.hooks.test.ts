import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlainOutcome } from '../addonScript';

const runPlainOnStack = vi.hoisted(() => vi.fn());
const composeOnStack = vi.hoisted(() => vi.fn(async (_args: string[], _options?: { profiles?: string[]; timeoutMs?: number }) => ''));
const state = vi.hoisted(() => ({ root: '/stack' as string | null, offered: true, enabled: true }));
const persistDebugLog = vi.hoisted(() => vi.fn());
const removeStaleSignerVolume = vi.hoisted(() => vi.fn(async () => 'current'));
const localStack = vi.hoisted(() => ({ on: false }));

vi.mock('../stackScripts', () => ({
  runOnStack: vi.fn(),
  runJsonOnStack: vi.fn(),
  runPlainOnStack,
  composeOnStack,
  stackPaths: () => ({ root: '/stack', dataRoot: '/stack/data' }),
}));
vi.mock('../../stackHost/activeStack', async () => {
  const { createFakeStackFiles } = await import('../../stackHost/fakeStackFiles');
  // In memory, so reads settle under fake timers. The service reads BITWARDEN_ENABLED from this
  // .env itself, past the bitwardenAddon mock below.
  const files = createFakeStackFiles({ 'stack:.env': 'BITWARDEN_ENABLED=1\n' });
  return { getStackFiles: () => files, stackFilesAt: () => files };
});
vi.mock('../../assistant/resolveAssistantRoot', () => ({ tryResolveAssistantRoot: () => ({ root: state.root }) }));
vi.mock('../bitwardenAddon', async () => ({
  ...(await vi.importActual<object>('../bitwardenAddon')),
  bitwardenOffered: () => state.offered,
  readBitwardenEnabled: () => state.enabled,
}));
vi.mock('../../../persistDebugLog', () => ({ persistDebugLog }));
vi.mock('../signerVolume', () => ({ removeStaleSignerVolume }));
vi.mock('../../assistant/localStackMode', () => ({ isLocalAssistantStackMode: () => localStack.on }));

import { notifyHermesReplaced, runBeforeStackUp } from '../../assistant/hermesLifecycle';
import { getBitwardenService, registerBitwardenStackHooks } from '../bitwardenRuntime';

const ok: PlainOutcome = { code: 0, stdout: '', stderrTail: [] };

/** Lets the fire-and-forget hermes-replaced listener finish; its reads are in memory. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let unregister: () => void;

beforeEach(() => {
  composeOnStack.mockClear();
  runPlainOnStack.mockReset().mockResolvedValue(ok);
  persistDebugLog.mockReset();
  removeStaleSignerVolume.mockClear();
  localStack.on = false;
  state.root = '/stack';
  state.offered = true;
  state.enabled = true;
  unregister = registerBitwardenStackHooks();
});

afterEach(() => unregister());

describe('registerBitwardenStackHooks', () => {
  it('runs nothing after a hermes restart: from stack 0.3.16 the broker has its own namespace', async () => {
    notifyHermesReplaced('web-search');
    await settle();
    expect(runPlainOnStack).not.toHaveBeenCalled();
    expect(composeOnStack).not.toHaveBeenCalled();
  });

  describe('runs pre-up before up only while Bitwarden is active', () => {
    it('runs vault.sh pre-up while active', async () => {
      await runBeforeStackUp();
      expect(runPlainOnStack).toHaveBeenCalledTimes(1);
      expect(runPlainOnStack).toHaveBeenCalledWith('vault.sh', ['pre-up'], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    });

    it('checks the signer volume before pre-up (CR 0042 R2)', async () => {
      const order: string[] = [];
      removeStaleSignerVolume.mockImplementationOnce(async () => {
        order.push('volume');
        return 'removed';
      });
      runPlainOnStack.mockImplementationOnce(async () => {
        order.push('pre-up');
        return ok;
      });
      await runBeforeStackUp();
      expect(order).toEqual(['volume', 'pre-up']);
    });

    it('leaves the signer volume alone in local-stack mode, which has no engine overlay', async () => {
      localStack.on = true;
      await runBeforeStackUp();
      expect(removeStaleSignerVolume).not.toHaveBeenCalled();
      expect(runPlainOnStack).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['not offered', () => { state.offered = false; }],
      ['switched off', () => { state.enabled = false; }],
      ['no stack root', () => { state.root = null; }],
    ])('does not call vault.sh when Bitwarden is %s', async (_name, turnOff) => {
      turnOff();
      await runBeforeStackUp();
      expect(runPlainOnStack).not.toHaveBeenCalled();
      expect(removeStaleSignerVolume).not.toHaveBeenCalled();
    });
  });

  it('fails the start with pre-up’s message', async () => {
    runPlainOnStack.mockResolvedValue({ code: 2, stdout: 'secret', stderrTail: ['secret'] });
    await expect(runBeforeStackUp()).rejects.toThrow('vault.sh pre-up exited 2');
    expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('secret');
  });

  describe('after a start', () => {
    it('runs up-hook only', async () => {
      notifyHermesReplaced('start');
      await settle();
      expect(runPlainOnStack.mock.calls).toEqual([['vault.sh', ['up-hook'], expect.objectContaining({ timeoutMs: expect.any(Number) })]]);
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
    ])('up-hook that %s is logged as metadata', async (_name, arrange, logged) => {
      arrange();
      notifyHermesReplaced('start');
      await settle();
      expect(persistDebugLog).toHaveBeenCalledWith('addons', 'bitwarden up-hook', expect.objectContaining(logged));
      expect(JSON.stringify(persistDebugLog.mock.calls)).not.toContain('secret');
    });
  });
});

describe('the broker repair', () => {
  it('starts a stopped broker with compose, under the bitwarden profile, without its dependencies', async () => {
    runPlainOnStack.mockResolvedValue(ok);
    const runJson = await import('../stackScripts');
    vi.mocked(runJson.runJsonOnStack)
      .mockResolvedValueOnce({ code: 1, objects: [], logTail: ['not running'] })
      .mockResolvedValue({ code: 0, objects: [], logTail: [] });
    await getBitwardenService().refresh();
    expect(composeOnStack.mock.calls).toEqual([
      [['up', '-d', '--no-deps', 'bitwarden-broker'], expect.objectContaining({ profiles: ['bitwarden'] })],
    ]);
  });
});
