import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntry } from '../../../../shared/types/inferenceChain';

interface ApplyOptions {
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  restoresRunningHermes?: boolean;
}

const stack = vi.hoisted(() => ({
  calls: [] as Array<{ options: ApplyOptions; finish: (result: { success: boolean; error?: string }) => void }>,
  ready: true,
}));
const broadcast = vi.hoisted(() => vi.fn());
const listRunningTurns = vi.hoisted(() => vi.fn((): unknown[] => []));
const getLastAppliedLlm = vi.hoisted(() => vi.fn((): unknown => null));

vi.mock('../../assistant/AssistantStackService', () => ({
  applyLlmConnectionToHermes: (_connection: unknown, options: ApplyOptions) =>
    new Promise((finish) => stack.calls.push({ options, finish })),
  isAssistantStackReady: async () => stack.ready,
}));
vi.mock('../../assistant/AssistantStackStore', () => ({ getLastAppliedLlm }));
vi.mock('../../assistant/hermes/hermesRunningTurns', () => ({ listRunningTurns }));
vi.mock('../../windows', () => ({ broadcast }));

import { cancelAppSwitch, currentAppSwitch, switchAppInference } from '../appInferenceSwitch';
import {
  clearOpenAiConfig,
  getAppDefaultSlot,
  getAppFallbacks,
  getAppSharedModel,
  getOpenAiOnboardingStatus,
  readAppInferenceChoice,
  restoreAppInferenceChoice,
  saveLlmConnection,
  saveOAuthCredentials,
  setAppDefault,
  setAppSharedModel,
  updateLlmModel,
} from '../OpenAiOnboardingStore';
import { MANUAL_LLM_CAPABILITIES, OAUTH_LLM_CAPABILITIES } from '../../../../shared/llmConnectionDefaults';

const shared: InferenceChainEntry = {
  slot: 'peer',
  modelId: 'qwen3-8b',
  peer: { circleId: 'c'.repeat(64), providerId: 'b'.repeat(64) },
};

/** Run the switch until the apply has been asked for, and hand back its stack call. */
async function untilApply(target: InferenceChainEntry, write: () => ReturnType<typeof setAppDefault>) {
  const asked = stack.calls.length;
  const result = switchAppInference(target, write);
  await vi.waitFor(() => expect(stack.calls.length).toBe(asked + 1));
  return { result, call: stack.calls[asked] };
}

const toOpenRouter = () => untilApply({ slot: 'openrouter' }, () => setAppDefault('openrouter'));

function published(): unknown[] {
  return broadcast.mock.calls.filter(([channel]) => channel === 'onboarding:app-switch').map(([, event]) => event);
}

beforeEach(async () => {
  stack.calls = [];
  stack.ready = true;
  broadcast.mockClear();
  listRunningTurns.mockReturnValue([]);
  getLastAppliedLlm.mockReturnValue({ slot: 'local', modelId: 'qwen3:14b' });
  await clearOpenAiConfig();
  await saveLlmConnection({
    endpointUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'dummy',
    modelId: 'qwen3:14b',
    provider: 'ollama',
    capabilities: MANUAL_LLM_CAPABILITIES,
    slot: 'local',
  });
  await saveOAuthCredentials({
    providerId: 'openrouter',
    providerDisplayName: 'OpenRouter',
    endpointUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-secret',
    authScheme: 'bearer',
    capabilities: OAUTH_LLM_CAPABILITIES,
  });
  await updateLlmModel('openai/gpt-4o', 'openrouter');
  await setAppDefault('local');
  broadcast.mockClear();
});

describe('switching the app default', () => {
  it('reports each stage from the apply, and ends with no switch running', async () => {
    const { result, call } = await toOpenRouter();
    call.options.onStage?.('applying');
    call.options.onStage?.('restarting');
    expect(currentAppSwitch().appSwitch).toMatchObject({
      target: { slot: 'openrouter' },
      previous: { slot: 'local' },
      phase: 'switching',
      stage: 'restarting',
    });
    call.finish({ success: true });
    expect(await result).toMatchObject({ success: true });
    expect(currentAppSwitch().appSwitch).toBeNull();
    expect(published().at(-1)).toEqual({ appSwitch: null });
    expect(getAppDefaultSlot()).toBe('openrouter');
  });

  it('refuses a second switch while one runs', async () => {
    const { result, call } = await toOpenRouter();
    const second = await switchAppInference({ slot: 'local' }, () => setAppDefault('local'));
    expect(second).toMatchObject({ success: false, error: 'The app default is still changing.' });
    call.finish({ success: true });
    await result;
  });

  it('passes on a failed apply and keeps the saved default for the next message', async () => {
    const { result, call } = await toOpenRouter();
    call.finish({ success: false, error: 'Hermes went away.' });
    expect(await result).toMatchObject({ success: true, applyError: 'Hermes went away.' });
    expect(getAppDefaultSlot()).toBe('openrouter');
  });

  it('leaves a running reply alone: it saves, and the next message moves Hermes', async () => {
    listRunningTurns.mockReturnValue([{ requestId: 'r1' }]);
    const result = await switchAppInference({ slot: 'openrouter' }, () => setAppDefault('openrouter'));
    expect(result).toMatchObject({ success: true, deferred: true });
    expect(stack.calls).toEqual([]);
    expect(getAppDefaultSlot()).toBe('openrouter');
    expect(currentAppSwitch().appSwitch).toBeNull();
  });

  it('skips the apply when the stack is not up', async () => {
    stack.ready = false;
    const result = await switchAppInference({ slot: 'openrouter' }, () => setAppDefault('openrouter'));
    expect(result).toMatchObject({ success: true });
    expect(stack.calls).toEqual([]);
  });
});

describe('cancelling a switch', () => {
  it('puts the store back before the stack has moved, and queues the way back', async () => {
    const { result, call } = await toOpenRouter();
    call.options.onStage?.('applying');
    expect(getAppDefaultSlot()).toBe('openrouter');

    const cancelling = cancelAppSwitch();
    expect(getAppDefaultSlot()).toBe('local');
    expect(call.options.signal?.aborted).toBe(true);
    const cancelled = await cancelling;
    expect(cancelled.status?.appDefault).toBe('local');
    expect(currentAppSwitch().appSwitch).toMatchObject({ phase: 'reverting', restartAgain: false });

    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    expect(stack.calls[1].options).toMatchObject({ restoresRunningHermes: true });
    expect(stack.calls[1].options.signal).toBeUndefined();

    call.finish({ success: false });
    expect(await result).toMatchObject({ success: true, cancelled: true });
    // The switch stays up until the stack is back.
    expect(currentAppSwitch().appSwitch).toMatchObject({ phase: 'reverting' });
    stack.calls[1].finish({ success: true });
    await vi.waitFor(() => expect(currentAppSwitch().appSwitch).toBeNull());
    expect(broadcast).toHaveBeenCalledWith('onboarding:status', expect.objectContaining({ appDefault: 'local' }));
  });

  it('says so when a restart is already under way', async () => {
    const { result, call } = await toOpenRouter();
    call.options.onStage?.('starting');
    await cancelAppSwitch();
    expect(currentAppSwitch().appSwitch).toMatchObject({ phase: 'reverting', restartAgain: true });
    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    call.finish({ success: true });
    // A stage from the run being replaced can't move the bar back to `switching`.
    call.options.onStage?.('applying');
    expect(currentAppSwitch().appSwitch).toMatchObject({ phase: 'reverting' });
    expect(await result).toMatchObject({ cancelled: true });
    stack.calls[1].finish({ success: true });
    await vi.waitFor(() => expect(currentAppSwitch().appSwitch).toBeNull());
  });

  it('needs no way back before anything has changed', async () => {
    const { result, call } = await toOpenRouter();
    await cancelAppSwitch();
    expect(getAppDefaultSlot()).toBe('local');
    expect(currentAppSwitch().appSwitch).toBeNull();
    call.finish({ success: false });
    expect(await result).toMatchObject({ cancelled: true });
    expect(stack.calls.length).toBe(1);
  });

  it('wins over a write still on its way to the store', async () => {
    let store!: () => void;
    const reached = new Promise<void>((resolve) => {
      store = resolve;
    });
    const result = switchAppInference({ slot: 'openrouter' }, async () => {
      await reached;
      return setAppDefault('openrouter');
    });
    await cancelAppSwitch();
    store();
    expect(await result).toMatchObject({ cancelled: true, status: { appDefault: 'local' } });
    expect(getAppDefaultSlot()).toBe('local');
    expect(stack.calls).toEqual([]);
  });

  it('restores a shared model with its fallbacks, since choosing a slot keeps neither in place', async () => {
    await setAppSharedModel(shared);
    restoreAppInferenceChoice({ ...readAppInferenceChoice(), fallbacks: [{ slot: 'local' }] });
    getLastAppliedLlm.mockReturnValue({ slot: 'peer', modelId: shared.modelId });

    const { result, call } = await toOpenRouter();
    call.options.onStage?.('applying');
    expect(getAppSharedModel()).toBeNull();
    await cancelAppSwitch();
    expect(getAppSharedModel()).toEqual(shared);
    expect(getAppDefaultSlot()).toBeNull();
    expect(getAppFallbacks()).toEqual([{ slot: 'local' }]);
    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    expect(stack.calls[1].options.restoresRunningHermes).toBe(true);
    call.finish({ success: false });
    stack.calls[1].finish({ success: true });
    await result;
    await vi.waitFor(() => expect(currentAppSwitch().appSwitch).toBeNull());
  });

  it('cancels a move to a shared model back to a slot', async () => {
    const { result, call } = await untilApply(shared, () => setAppSharedModel(shared));
    call.options.onStage?.('applying');
    expect(getAppSharedModel()).toEqual(shared);
    await cancelAppSwitch();
    expect(getAppSharedModel()).toBeNull();
    expect(getAppDefaultSlot()).toBe('local');
    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    call.finish({ success: false });
    stack.calls[1].finish({ success: true });
    await result;
    await vi.waitFor(() => expect(currentAppSwitch().appSwitch).toBeNull());
  });

  it('restarts on the way back when Hermes was serving something else, such as a chat override', async () => {
    getLastAppliedLlm.mockReturnValue({ slot: 'openrouter', modelId: 'other/model' });
    const { result, call } = await toOpenRouter();
    call.options.onStage?.('applying');
    await cancelAppSwitch();
    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    expect(stack.calls[1].options.restoresRunningHermes).toBe(false);
    call.finish({ success: false });
    stack.calls[1].finish({ success: true });
    await result;
    await vi.waitFor(() => expect(currentAppSwitch().appSwitch).toBeNull());
  });

  it('tells the user when the way back fails, and keeps the previous default saved', async () => {
    const { result, call } = await toOpenRouter();
    call.options.onStage?.('applying');
    await cancelAppSwitch();
    await vi.waitFor(() => expect(stack.calls.length).toBe(2));
    call.finish({ success: false });
    stack.calls[1].finish({ success: false, error: 'Hermes went away.' });
    await result;
    await vi.waitFor(() =>
      expect(published().at(-1)).toEqual({
        appSwitch: null,
        error: 'The previous model is saved, but the assistant didn’t go back to it: Hermes went away.',
      })
    );
    expect((await getOpenAiOnboardingStatus()).appDefault).toBe('local');
  });

  it('does nothing when no switch is running', async () => {
    expect(await cancelAppSwitch()).toMatchObject({ success: true, status: { appDefault: 'local' } });
    expect(published()).toEqual([]);
  });
});
