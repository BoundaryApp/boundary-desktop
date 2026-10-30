import { describe, expect, it } from 'vitest';
import type { InferenceChain } from '../../../../../shared/types/inferenceChain';
import {
  applyPrivacyLock,
  chainContextLength,
  describeInferenceChain,
  pickInferenceChain,
  type InferenceChainFacts,
} from '../resolveChain';

const dana = { circleId: 'c1', providerId: 'dana' };

function facts(overrides: Partial<InferenceChainFacts> = {}): InferenceChainFacts {
  return {
    slotConfigured: (slot) => slot !== 'infrastructure',
    slotContextLength: (slot) => (slot === 'local' ? 32_768 : 200_000),
    circleJoined: () => true,
    peerOffer: () => ({ 'qwen3-32b': { contextLength: 65_536 } }),
    providerPrivate: () => false,
    providerTrusted: () => true,
    ...overrides,
  };
}

const chain: InferenceChain = [
  { slot: 'peer', peer: dana, modelId: 'qwen3-32b' },
  { slot: 'local', modelId: 'qwen3:14b' },
  { slot: 'openrouter', modelId: 'anthropic/claude-sonnet-5-5' },
];

describe('pickInferenceChain', () => {
  it('takes the first level that has a chain, without merging', () => {
    const project: InferenceChain = [{ slot: 'local' }];
    const app: InferenceChain = [{ slot: 'openrouter' }];
    expect(pickInferenceChain({ chat: chain, project, app })).toEqual({
      chain,
      provenance: 'chat-override',
    });
    expect(pickInferenceChain({ chat: [], project, app })).toEqual({
      chain: project,
      provenance: 'project-default',
    });
    expect(pickInferenceChain({ chat: null, app })?.provenance).toBe('app-default');
    expect(pickInferenceChain({})).toBeNull();
  });
});

describe('describeInferenceChain', () => {
  it('marks privacy and context for each entry', () => {
    const states = describeInferenceChain(chain, facts());
    expect(states.map((s) => [s.key, s.private, s.contextLength, s.stale])).toEqual([
      ['peer:c1:dana:qwen3-32b', false, 65_536, null],
      ['local:qwen3:14b', true, 32_768, null],
      ['openrouter:anthropic/claude-sonnet-5-5', false, 200_000, null],
    ]);
  });

  it('counts a shared model as private only when its provider is marked private', () => {
    const states = describeInferenceChain(chain, facts({ providerPrivate: (id) => id === 'dana' }));
    expect(states[0].private).toBe(true);
  });

  it('marks stale entries with the reason', () => {
    const entries: InferenceChain = [
      { slot: 'infrastructure' },
      { slot: 'peer', peer: dana, modelId: 'qwen3-32b' },
      { slot: 'peer', peer: { circleId: 'c2', providerId: 'eli' }, modelId: 'llama' },
      { slot: 'peer', peer: { circleId: 'c3', providerId: 'fay' }, modelId: 'gone' },
      { slot: 'peer', peer: { circleId: 'c4', providerId: 'gus' }, modelId: 'other' },
    ];
    const states = describeInferenceChain(
      entries,
      facts({
        circleJoined: (id) => id !== 'c1',
        peerOffer: (peer) => (peer.providerId === 'eli' ? null : { other: {} }),
        providerTrusted: (id) => id !== 'gus',
      })
    );
    expect(states.map((s) => s.stale)).toEqual([
      'slot-not-configured',
      'left-circle',
      'offer-withdrawn',
      'model-not-offered',
      'provider-untrusted',
    ]);
    expect(states.every((s) => s.contextLength === undefined)).toBe(true);
  });
});

describe('applyPrivacyLock', () => {
  it('leaves the chain alone when the project is not locked', () => {
    const states = describeInferenceChain(chain, facts());
    expect(applyPrivacyLock(states, false)).toEqual({ ok: true, entries: states });
  });

  it('cuts the chain at the first entry that is not private', () => {
    const states = describeInferenceChain(
      [{ slot: 'local' }, { slot: 'openrouter' }, { slot: 'local', modelId: 'other' }],
      facts()
    );
    const locked = applyPrivacyLock(states, true);
    expect(locked.ok && locked.entries.map((s) => s.key)).toEqual(['local:']);
  });

  it('refuses when no usable private entry comes before the cut', () => {
    const states = describeInferenceChain(chain, facts());
    expect(applyPrivacyLock(states, true)).toEqual({ ok: false, reason: 'no-private-entry' });

    const staleLocal = describeInferenceChain([{ slot: 'local' }], facts({ slotConfigured: () => false }));
    expect(applyPrivacyLock(staleLocal, true).ok).toBe(false);
  });
});

describe('chainContextLength', () => {
  it('is the smallest known context among usable entries', () => {
    expect(chainContextLength(describeInferenceChain(chain, facts()))).toBe(32_768);
    expect(chainContextLength(describeInferenceChain([{ slot: 'infrastructure' }], facts()))).toBeUndefined();
  });
});
