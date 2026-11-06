import { describe, expect, it } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../../shared/types/inferenceChain';
import { chainCandidates, describeChainEntry, type ChainContext } from '../entries';
import { describeStackHere, levelRefuses } from '../stack';

const CIRCLE = 'c'.repeat(64);
const BO = 'b'.repeat(64);
const ME = 'a'.repeat(64);

function circles(overrides: Partial<CirclesState> = {}, offer: Partial<CirclesState['snapshot']['circles'][0]['offers'][0]> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: { [BO]: { private: false, trusted: true } },
    snapshot: {
      identity: ME,
      circles: [
        {
          key: CIRCLE,
          name: 'Workshop',
          myRole: 'member',
          writable: true,
          members: [],
          invites: [],
          offers: [
            {
              identity: BO,
              name: 'Bo',
              isMine: false,
              models: [{ id: 'qwen3-8b', tools: true }, { id: 'gemma', tools: false }],
              available: true,
              away: false,
              online: true,
              ...offer,
            },
            { identity: ME, name: 'Ada', isMine: true, models: [{ id: 'mine', tools: false }], available: true, away: false, online: true },
          ],
        },
      ],
    },
    ...overrides,
  };
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
