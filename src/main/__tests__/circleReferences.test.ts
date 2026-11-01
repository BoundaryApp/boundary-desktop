import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import type { HermesProjectRecord } from '../../shared/types/hermesChat';
import {
  listStoredHermesProjects,
  replaceStoredHermesProjects,
  resetHermesProjectsStoreForTests,
} from '../services/assistant/hermes/hermesProjectStore';
import {
  clearOpenAiConfig,
  getAppDefaultSlot,
  getAppFallbacks,
  getAppSharedModel,
  restoreAppInferenceChoice,
  saveLlmConnection,
} from '../services/onboarding/OpenAiOnboardingStore';
import { dropWipedCircleReferences } from '../migrations/circleReferences';
import { runMigrations } from '../migrations/runner';

const circles = vi.hoisted(() => ({ kept: new Set<string>(), trusted: new Set<string>() }));
vi.mock('../services/circles/circlesStore', () => ({
  circlesKeptByWipe: () => circles.kept,
  getProviderSettings: () => Object.fromEntries([...circles.trusted].map((id) => [id, { trusted: true }])),
}));
vi.mock('../migrations/hermesAgentsStores', () => ({ dropChatFallbacksInEveryStore: vi.fn() }));

const WIPED = 'a'.repeat(64);
const JOINED = 'b'.repeat(64);
const BO = 'c'.repeat(64);

const shared = (circleId: string, modelId = 'qwen3-8b'): InferenceChainEntry => ({
  slot: 'peer',
  modelId,
  peer: { circleId, providerId: BO },
});

const openRouter = {
  endpointUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test',
  modelId: 'anthropic/claude-sonnet-4',
};

const choose = (chosen: InferenceChainEntry | null, fallbacks: InferenceChainEntry[], appDefault: 'openrouter' | null = null) =>
  restoreAppInferenceChoice({ appDefault, shared: chosen, fallbacks });

describe('clearing references to wiped Circles', () => {
  beforeEach(async () => {
    await clearOpenAiConfig();
    resetHermesProjectsStoreForTests();
    choose(null, []);
    circles.kept = new Set([JOINED]);
    circles.trusted = new Set([BO]);
  });

  it('moves the default to the first fallback that may serve', async () => {
    await saveLlmConnection(openRouter);
    choose(shared(WIPED), [shared(WIPED, 'other'), { slot: 'openrouter' }]);
    dropWipedCircleReferences();
    expect(getAppSharedModel()).toBeNull();
    expect(getAppDefaultSlot()).toBe('openrouter');
    expect(getAppFallbacks()).toEqual([]);
  });

  it('moves it to a shared fallback from a Circle that’s still here, only if its provider is trusted', () => {
    choose(shared(WIPED), [shared(JOINED)]);
    dropWipedCircleReferences();
    expect(getAppSharedModel()).toEqual(shared(JOINED));
    expect(getAppFallbacks()).toEqual([]);

    circles.trusted = new Set();
    choose(shared(WIPED), [shared(JOINED)]);
    dropWipedCircleReferences();
    expect(getAppSharedModel()).toBeNull();
    expect(getAppFallbacks()).toEqual([shared(JOINED)]);
  });

  it('takes a connected provider when no fallback remains', async () => {
    await saveLlmConnection(openRouter);
    choose(shared(WIPED), []);
    dropWipedCircleReferences();
    expect(getAppDefaultSlot()).toBe('openrouter');
  });

  it('leaves nothing chosen when no model remains', () => {
    choose(shared(WIPED), [shared(WIPED, 'other')]);
    dropWipedCircleReferences();
    expect(getAppSharedModel()).toBeNull();
    expect(getAppDefaultSlot()).toBeNull();
    expect(getAppFallbacks()).toEqual([]);
  });

  it('leaves a default in a Circle that’s still here, and a slot default, and removes only wiped fallbacks', async () => {
    choose(shared(JOINED), [shared(WIPED)]);
    dropWipedCircleReferences();
    expect(getAppSharedModel()).toEqual(shared(JOINED));
    expect(getAppFallbacks()).toEqual([]);

    await saveLlmConnection(openRouter);
    choose(null, [shared(WIPED), shared(JOINED)], 'openrouter');
    dropWipedCircleReferences();
    expect(getAppDefaultSlot()).toBe('openrouter');
    expect(getAppFallbacks()).toEqual([shared(JOINED)]);
  });

  it('clears project fallbacks', () => {
    const project = (id: string, fallbacks: InferenceChainEntry[]) =>
      ({ id, inference: { mode: 'local', fallbacks } }) as unknown as HermesProjectRecord;
    replaceStoredHermesProjects([project('wiped', [shared(WIPED), { slot: 'local' }]), project('kept', [shared(JOINED)])]);
    dropWipedCircleReferences();
    expect(listStoredHermesProjects().map((item) => item.inference?.fallbacks)).toEqual([[{ slot: 'local' }], [shared(JOINED)]]);
  });

  it('runs once, so a Circle left later keeps its model selected (ADR 0036 §5)', () => {
    const ran = new Set<string>();
    const record = { has: (id: string) => ran.has(id), add: (id: string) => void ran.add(id) };
    const migration = { id: 'test', removeAfter: '0.1.0', run: () => dropWipedCircleReferences() };
    runMigrations([migration], record);
    choose(shared(JOINED), []);
    circles.kept = new Set();
    runMigrations([migration], record);
    expect(getAppSharedModel()).toEqual(shared(JOINED));
  });
});
