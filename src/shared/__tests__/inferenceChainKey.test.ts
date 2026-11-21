import { describe, expect, it } from 'vitest';
import { chainEntryKey, shortChainKey } from '../inferenceChainKey';

const CIRCLE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROVIDER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// Stored fallbacks and served-by headers are matched by these strings; do not change them.
describe('chainEntryKey', () => {
  it('names a slot entry as slot:model', () => {
    expect(chainEntryKey({ slot: 'openrouter', modelId: ' gpt-5 ' })).toBe('openrouter:gpt-5');
    expect(chainEntryKey({ slot: 'openrouter' })).toBe('openrouter:');
  });

  it('names a pool as confidential:model', () => {
    expect(chainEntryKey({ slot: 'confidential', modelId: 'm1' })).toBe('confidential:m1');
  });

  it('names a shared model as peer:circle:provider:model', () => {
    expect(
      chainEntryKey({ slot: 'peer', modelId: ' llama ', peer: { circleId: CIRCLE, providerId: PROVIDER } })
    ).toBe(`peer:${CIRCLE}:${PROVIDER}:llama`);
  });

  it('leaves the parts of a peer without a ref empty', () => {
    expect(chainEntryKey({ slot: 'peer', modelId: 'llama' })).toBe('peer:::llama');
  });
});

describe('shortChainKey', () => {
  it('shortens the hex ids of a shared model key to 8 characters', () => {
    expect(shortChainKey(`peer:${CIRCLE}:${PROVIDER}:llama`)).toBe('peer:aaaaaaaa:bbbbbbbb:llama');
  });

  it('leaves a key that is not a shared model as it is', () => {
    expect(shortChainKey(`openrouter:${CIRCLE}`)).toBe(`openrouter:${CIRCLE}`);
    expect(shortChainKey('confidential:m1')).toBe('confidential:m1');
  });
});
