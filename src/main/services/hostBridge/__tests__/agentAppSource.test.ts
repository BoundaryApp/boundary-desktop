import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterChain } from '../../inference/router/chainRouter';
import type { LastAppliedLlm } from '../../../../shared/types/assistantStack';

const state = vi.hoisted(() => ({
  packaged: false,
  localStack: false,
  applied: null as LastAppliedLlm | null,
  chain: null as RouterChain | null,
  trusted: new Set<string>(),
  log: '',
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged;
    },
    getVersion: () => '1.2.3',
  },
}));
vi.mock('../../assistant/AssistantStackService', () => ({ isAssistantStackReady: async () => true }));
vi.mock('../../assistant/AssistantStackStore', () => ({ getLastAppliedLlm: () => state.applied }));
vi.mock('../../assistant/localStackMode', () => ({ isLocalAssistantStackMode: () => state.localStack }));
vi.mock('../../circles/circlesService', () => ({
  sharedModelFacts: () => ({ providerTrusted: (id: string) => state.trusted.has(id) }),
}));
vi.mock('../../inference/inferenceRouterService', () => ({ inferenceRouterChain: () => state.chain }));
vi.mock('../../onboarding/OpenAiOnboardingStore', () => ({
  getSlotLlmConnection: async (slot: string) =>
    slot === 'local' ? { endpointUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen' } : null,
}));
vi.mock('../../updates/ipcHandlers', () => ({ currentUpdateSnapshot: () => null }));
vi.mock('../../../persistDebugLog', () => ({ readDebugLogTail: () => ({ path: '', contents: state.log }) }));
vi.mock('../hostBridgeService', () => ({ getHostToolsState: () => 'connected' }));

import { agentAppSource, noteAppScreen } from '../agentAppSource';

const direct = (slot: LastAppliedLlm['slot'], endpointUrl: string): LastAppliedLlm => ({
  slot,
  endpointUrl,
  modelId: 'm',
  appliedAt: 'now',
});
const routed = { ...direct('local', 'http://127.0.0.1:9/v1'), routed: true };

describe('agentAppSource.check', () => {
  beforeEach(() => {
    delete process.env.BOUNDARY_AGENT_APP_ACCESS;
    Object.assign(state, { packaged: false, localStack: false, applied: null, chain: null, log: '' });
    state.trusted.clear();
  });

  it('refuses in a packaged build unless the variable is set', async () => {
    state.packaged = true;
    state.applied = direct('local', 'http://127.0.0.1:1234/v1');
    expect((await agentAppSource.check()).ok).toBe(false);
    process.env.BOUNDARY_AGENT_APP_ACCESS = '1';
    expect((await agentAppSource.check()).ok).toBe(true);
  });

  it('refuses in local-stack mode, whatever was applied', async () => {
    state.localStack = true;
    state.applied = direct('local', 'http://127.0.0.1:1234/v1');
    expect(await agentAppSource.check()).toEqual({
      ok: false,
      reason: 'Refused because the model route of a local stack is unknown.',
    });
  });

  it('checks a direct route from the applied connection', async () => {
    state.applied = direct('openrouter', 'https://openrouter.ai/api/v1');
    expect((await agentAppSource.check()).ok).toBe(false);
  });

  it('refuses a routed stack with no chain', async () => {
    state.applied = routed;
    expect((await agentAppSource.check()).ok).toBe(false);
  });

  it('checks every entry of a routed chain, offline ones too, and skips ones that cannot serve', async () => {
    state.applied = routed;
    state.trusted.add('friend');
    const peer = { circleId: 'c', providerId: 'friend' };
    const entry = (slot: 'local' | 'peer' | 'openrouter', stale: string | null) => ({
      entry: { slot, modelId: slot, ...(slot === 'peer' ? { peer } : {}) },
      key: slot,
      stale,
      private: false,
    });
    state.chain = {
      entries: [entry('local', null), entry('peer', 'provider-offline'), entry('openrouter', 'slot-not-configured')],
      upstreams: { local: { baseUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen' } },
      modelId: 'qwen',
    } as RouterChain;
    expect((await agentAppSource.check()).ok).toBe(true);

    state.trusted.clear();
    expect((await agentAppSource.check()).ok).toBe(false);
  });

  it('refuses a live cloud fallback in a routed chain', async () => {
    state.applied = routed;
    state.chain = {
      entries: [
        { entry: { slot: 'local' }, key: 'local', stale: null, private: true },
        { entry: { slot: 'openrouter', modelId: 'gpt' }, key: 'cloud', stale: null, private: false },
      ],
      upstreams: {
        local: { baseUrl: 'http://127.0.0.1:1234/v1', modelId: 'qwen' },
        cloud: { baseUrl: 'https://openrouter.ai/api/v1', modelId: 'gpt' },
      },
      modelId: 'qwen',
    } as RouterChain;
    expect(await agentAppSource.check()).toEqual({ ok: false, reason: 'Refused because gpt is a cloud model.' });
  });
});

describe('agentAppSource.status', () => {
  it('reports the screen and leaves out endpoints', async () => {
    state.applied = direct('local', 'http://secret-host:1234/v1');
    noteAppScreen({ view: 'chat', sheet: 'passwords' });
    const status = await agentAppSource.status();
    expect(status).toMatchObject({ version: '1.2.3', screen: { view: 'chat', sheet: 'passwords' }, stackReady: true });
    expect(JSON.stringify(status)).not.toContain('secret-host');
  });

  it('ignores a screen report that is not an id', async () => {
    noteAppScreen({ view: 'chat', sheet: null });
    noteAppScreen({ view: 'a message someone typed', sheet: null });
    expect((await agentAppSource.status()).screen).toEqual({ view: 'chat', sheet: null });
  });
});

describe('agentAppSource.problems', () => {
  it('removes the home folder from what it returns', () => {
    const home = process.env.HOME ?? '/nonexistent';
    state.log = JSON.stringify({ ts: 't', area: 'podman', message: `podman failed at ${home}/x`, data: {} });
    expect(JSON.stringify(agentAppSource.problems())).not.toContain(home);
  });
});
