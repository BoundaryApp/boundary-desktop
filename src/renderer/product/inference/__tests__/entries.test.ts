import { describe, expect, it } from 'vitest';
import type { CircleOfferView, CirclesState } from '../../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../../shared/types/inferenceChain';
import { BO, CIRCLE_KEY as CIRCLE, ME, circleOffer, circleSnapshot, runningCircles } from '../../../__tests__/circleFixtures';
import { chainCandidates, describeChainEntry, type ChainContext } from '../entries';
import { describeStackHere, levelRefuses } from '../stack';
import { EMPTY_RANKING, QWEN_RANKING, poolState } from '../../../__tests__/confidentialFixtures';
import type { PoolRanking } from '../../../../shared/types/confidentialState';

function circles(overrides: Partial<CirclesState> = {}, offer: Partial<CircleOfferView> = {}): CirclesState {
  const offers = [
    circleOffer({ models: [{ id: 'qwen3-8b', tools: true }, { id: 'gemma', tools: false }], ...offer }),
    circleOffer({ identity: ME, name: 'Ada', isMine: true, models: [{ id: 'mine', tools: false }] }),
  ];
  return runningCircles({
    providers: { [BO]: { private: false, trusted: true } },
    circles: [circleSnapshot({ name: 'Workshop', offers })],
    ...overrides,
  });
}

const slots: ChainContext['slots'] = {
  local: { configured: true, modelId: 'qwen3:14b' } as ChainContext['slots']['local'],
  openrouter: { configured: true, modelId: 'anthropic/claude-sonnet-4' } as ChainContext['slots']['openrouter'],
};

const shared = (modelId = 'qwen3-8b'): InferenceChainEntry => ({ slot: 'peer', modelId, peer: { circleId: CIRCLE, providerId: BO } });

describe('shared models as the app default (ADR 0036)', () => {
  it('says what stops chats, since no entry comes after it', () => {
    const detail = (state: CirclesState, entry = shared()) => describeChainEntry(entry, { slots, circles: state }, 'first').detail;
    expect(detail(circles({ providers: {} }))).toMatch(/Trust Bo in Inference to use it/);
    expect(detail(circles({}, { available: false }))).toMatch(/Chats can’t send until that changes/);
    expect(detail(circles({}, { online: false }))).toMatch(/Offline now, so chats can’t send/);
    expect(detail(circles(), shared('gemma'))).toMatch(/Doesn’t support tool calls/);
  });

  it('doesn’t offer the first entry again as a fallback', () => {
    const labels = chainCandidates(shared(), [], { slots, circles: circles() }).map((view) => view.label);
    expect(labels).not.toContain("Bo's qwen3-8b");
    expect(labels).toContain("Bo's gemma");
  });
});

describe('describeChainEntry', () => {
  it('says why a shared model is skipped, in the order main checks', () => {
    const cases: Array<[CirclesState, InferenceChainEntry, RegExp]> = [
      [circles({ status: 'starting' }), shared(), /Circles aren’t connected/],
      [circles({ snapshot: { identity: ME, circles: [] } }), shared(), /no longer in that Circle/],
      [circles({}, { available: false }), shared(), /Bo isn’t sharing it now/],
      [circles(), shared('gone'), /No longer shared/],
      [circles({ providers: {} }), shared(), /until you trust Bo in Inference/],
    ];
    for (const [state, entry, reason] of cases) {
      const view = describeChainEntry(entry, { slots, circles: state });
      expect({ detail: view.detail, skipped: view.skipped }).toEqual({ detail: expect.stringMatching(reason), skipped: true });
    }
  });

  it('serves a trusted provider’s model, saying when they are offline and whether it is private', () => {
    expect(describeChainEntry(shared(), { slots, circles: circles() })).toMatchObject({
      label: "Bo's qwen3-8b",
      skipped: false,
      detail: 'Shared in Workshop. Not for private projects.',
    });
    const offline = describeChainEntry(shared(), {
      slots,
      circles: circles({ providers: { [BO]: { private: true, trusted: true } } }, { online: false }),
    });
    expect(offline).toMatchObject({
      skipped: true,
      offline: true,
      detail: expect.stringMatching(/Offline now\. Skipped\..*Can serve private projects/),
    });
  });

  it('marks a disconnected provider skipped', () => {
    expect(describeChainEntry({ slot: 'openrouter' }, { slots: { local: slots.local }, circles: circles() })).toMatchObject({
      skipped: true,
      detail: 'Not connected. Skipped.',
    });
  });
});

describe('a confidential pool', () => {
  const pool: InferenceChainEntry = { slot: 'confidential', modelId: 'meta-llama/llama-3.3-70b' };
  const qwen: InferenceChainEntry = { slot: 'confidential', modelId: 'qwen' };
  const state = poolState();
  const pools = (rankings?: Record<string, PoolRanking | null>): ChainContext['pools'] =>
    state.enabled === true ? { models: state.models, providers: state.providers, ...(rankings ? { rankings } : {}) } : undefined;

  it('is labelled by its model id without pool state, skipped, stale and never private', () => {
    const ctx = { slots, circles: circles() };
    expect(describeChainEntry(pool, ctx)).toEqual({
      entry: pool,
      label: 'Confidential · meta-llama/llama-3.3-70b',
      detail: 'No added provider serves this model now. Skipped.',
      skipped: true,
    });
    const stack = describeStackHere([{ slot: 'local' }, pool], ctx);
    expect(stack.entries.map((state) => [state.key, state.stale, state.private])).toEqual([
      ['local:', null, true],
      ['confidential:meta-llama/llama-3.3-70b', 'pool-no-provider', false],
    ]);
  });

  it('is stale only when a ranking says nobody serves it', () => {
    const stale = (rankings?: Record<string, PoolRanking | null>) =>
      describeStackHere([qwen], { slots, circles: circles(), pools: pools(rankings) }).entries[0].stale;
    expect(stale({ qwen: QWEN_RANKING })).toBeNull();
    expect(stale({ qwen: EMPTY_RANKING })).toBe('pool-no-provider');
    expect(stale({ qwen: null })).toBe('pool-no-provider');
    // Without rankings, or while this one loads, main's plan decides.
    expect(stale({})).toBeNull();
    expect(stale()).toBeNull();
  });

  it('is labelled with the model’s name, and its detail comes from the ranking', () => {
    const view = (rankings?: Record<string, PoolRanking | null>) =>
      describeChainEntry(qwen, { slots, circles: circles(), pools: pools(rankings) });
    expect(view({ qwen: QWEN_RANKING })).toMatchObject({
      label: 'Confidential · Qwen 3.8 27B',
      detail: '2 providers · New chats go to NEAR AI Cloud, about $0.012 a turn',
      skipped: false,
    });
    expect(view({ qwen: EMPTY_RANKING })).toMatchObject({ detail: 'No provider in this pool can serve now', skipped: true });
    expect(view({ qwen: null }).detail).toBe('No provider in this pool can serve now');
    // While the ranking loads, the rung says so instead of an error.
    expect(view({})).toMatchObject({ detail: 'Finding who serves it', skipped: false });
    // Without rankings (the chip, the inspector), nothing is known here, so it isn't marked skipped.
    expect(view()).toMatchObject({ detail: 'Served by your confidential providers', skipped: false });
    const none = describeChainEntry(qwen, {
      slots,
      circles: circles(),
      pools: { models: state.enabled === true ? state.models : [], providers: [], rankings: { qwen: EMPTY_RANKING } },
    });
    expect(none.detail).toBe('No confidential providers added yet');
  });

  it('is offered once per catalog model, only when pools are on', () => {
    const ctx = { slots, circles: circles(), pools: pools({ qwen: QWEN_RANKING, dsflash: EMPTY_RANKING }) };
    const offered = chainCandidates({ slot: 'local' }, [], ctx).filter((view) => view.entry.slot === 'confidential');
    expect(offered.map(({ label, detail }) => [label, detail])).toEqual([
      ['Confidential · Qwen 3.8 27B', '2 of your providers · from $0.012 a turn'],
      ['Confidential · DeepSeek V4.1 Flash', 'None of your providers carry it'],
    ]);
    expect(offered[0].entry).toEqual(qwen);
    const loading = chainCandidates({ slot: 'local' }, [], { slots, circles: circles(), pools: pools({}) });
    expect(loading.find((view) => view.label === 'Confidential · Qwen 3.8 27B')?.detail).toBe('Finding who serves it');
    // One already in the stack isn't offered again.
    expect(chainCandidates({ slot: 'local' }, [qwen], ctx).filter((view) => view.entry.slot === 'confidential')).toHaveLength(1);
    expect(chainCandidates({ slot: 'local' }, [], { slots, circles: circles() }).some((view) => view.entry.slot === 'confidential')).toBe(
      false
    );
  });

  it('can’t come first in a chat’s or project’s stack, and may follow', () => {
    expect(levelRefuses([pool, { slot: 'local' }], { privacyLocked: false })).toBe(
      'A confidential pool can follow Local or OpenRouter here, but can’t come first. To start with one, put it first in Inference, then go back to the Chat stack here.'
    );
    expect(levelRefuses([{ slot: 'local' }, pool], { privacyLocked: false })).toBeNull();
  });
});

describe('chainCandidates', () => {
  it('offers the other provider and others’ shared models not already in the chain', () => {
    const labels = chainCandidates({ slot: 'local' }, [shared()], { slots, circles: circles() }).map((view) => view.label);
    expect(labels).toEqual(['OpenRouter · claude-sonnet-4', "Bo's gemma"]);
  });
});

describe('a candidate that can’t serve yet', () => {
  const untrusted = { slots, circles: circles({ providers: {} }) };

  it('says so, in words that don’t read as an active fallback', () => {
    const [view] = chainCandidates({ slot: 'local' }, [], untrusted).filter((item) => item.entry.slot === 'peer');
    expect(view).toMatchObject({ skipped: true, detail: 'Shared in Workshop. Can’t be used until you trust Bo in Inference.' });
    expect(view.detail).not.toMatch(/Skipped/);
    const offline = { slots, circles: circles({}, { online: false }) };
    expect(chainCandidates({ slot: 'local' }, [], offline).find((item) => item.entry.slot === 'peer')?.detail).toMatch(
      /Offline now, so it can’t be used yet/
    );
  });
});

describe('a chat’s or project’s stack, described in the renderer', () => {
  const ctx = (state: CirclesState): ChainContext => ({ slots, circles: state });

  it('marks each entry stale in the order main checks, and where a private project stops', () => {
    const stack = describeStackHere(
      [{ slot: 'local' }, shared(), { slot: 'openrouter' }],
      ctx(circles({ providers: { [BO]: { private: true, trusted: false } } }))
    );
    expect(stack.entries.map(({ stale, private: isPrivate, privateCut }) => ({ stale, isPrivate, privateCut }))).toEqual([
      { stale: null, isPrivate: true, privateCut: false },
      { stale: 'provider-untrusted', isPrivate: true, privateCut: false },
      { stale: null, isPrivate: false, privateCut: true },
    ]);
    expect(stack.noPrivate).toBe(false);
    expect(describeStackHere([shared('gone')], ctx(circles())).entries[0].stale).toBe('model-not-offered');
    expect(describeStackHere([shared()], ctx(circles({}, { online: false }))).entries[0].stale).toBe('provider-offline');
    expect(describeStackHere([{ slot: 'openrouter' }, { slot: 'local' }], ctx(circles()))).toMatchObject({ noPrivate: true });
  });

  it('refuses a shared model first, and a cloud model first in a private project', () => {
    expect(levelRefuses([shared(), { slot: 'local' }], { privacyLocked: false })).toMatch(/can’t come first/);
    expect(levelRefuses([{ slot: 'openrouter' }, shared()], { privacyLocked: false })).toBeNull();
    expect(levelRefuses([{ slot: 'openrouter' }], { privacyLocked: true })).toMatch(/must be Local/);
    expect(levelRefuses([], { privacyLocked: false })).toMatch(/at least one/);
  });
});
