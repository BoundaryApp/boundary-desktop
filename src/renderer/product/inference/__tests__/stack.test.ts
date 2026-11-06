import { describe, expect, it } from 'vitest';
import type { InferenceChainEntry, InferenceStack, InferenceStackEntry } from '../../../../shared/types/inferenceChain';
import { emptyInferenceProvidersStatus } from '../../../../shared/types/onboarding';
import { dryRun, entryState, moveEntry, removeEntry, skipReason, stackChange, storedStack } from '../stack';

const PEER = { circleId: 'c'.repeat(64), providerId: 'a'.repeat(64) };
const local: InferenceChainEntry = { slot: 'local' };
const cloud: InferenceChainEntry = { slot: 'openrouter' };
const maya: InferenceChainEntry = { slot: 'peer', modelId: 'qwen3-32b', peer: PEER };

const state = (entry: InferenceChainEntry, extra: Partial<InferenceStackEntry> = {}): InferenceStackEntry => ({
  entry,
  key: entry.slot === 'peer' ? `peer:${PEER.circleId}:${PEER.providerId}:qwen3-32b` : `${entry.slot}:`,
  stale: null,
  private: entry.slot === 'local',
  privateCut: entry.slot !== 'local',
  ...extra,
});

describe('the Inference stack', () => {
  it('puts the first entry and the fallbacks in one list, without the infrastructure slot', () => {
    const status = { ...emptyInferenceProvidersStatus(), appDefault: 'local' as const, appFallbacks: [maya, cloud] };
    expect(storedStack(status)).toEqual([local, maya, cloud]);
    expect(storedStack({ ...status, appDefault: null, appSharedModel: maya, appFallbacks: [] })).toEqual([maya]);
    expect(storedStack({ ...status, appDefault: 'infrastructure', appFallbacks: [] })).toEqual([]);
    expect(storedStack(null)).toEqual([]);
    // A fallback equal to the first entry is listed once, as main plans it.
    expect(storedStack({ ...status, appDefault: 'local', appFallbacks: [local, maya] })).toEqual([local, maya]);
  });

  it('moves and removes entries, and leaves the ends alone', () => {
    expect(moveEntry([local, maya, cloud], 1, -1)).toEqual([maya, local, cloud]);
    expect(moveEntry([local, maya], 0, -1)).toEqual([local, maya]);
    expect(moveEntry([local, maya], 1, 1)).toEqual([local, maya]);
    expect(removeEntry([local, maya, cloud], 1)).toEqual([local, cloud]);
  });

  it('asks for an app switch only when the first entry changes, by slot alone', () => {
    expect(stackChange([local, maya, cloud], [local, cloud, maya])).toEqual({ first: null, fallbacks: [cloud, maya] });
    expect(stackChange([local, maya], [maya, local])).toEqual({ first: maya, fallbacks: [local] });
    expect(stackChange([maya, cloud], [{ slot: 'openrouter', modelId: 'x/y' }, maya])).toEqual({
      first: cloud,
      fallbacks: [maya],
    });
  });

  it('matches main’s description to a stored entry by key', () => {
    const stack: InferenceStack = { entries: [state(local), state(maya)], noPrivate: false };
    expect(entryState(stack, maya)?.entry).toEqual(maya);
    expect(entryState(stack, cloud)).toBeNull();
  });

  it('names why an entry is skipped, from its state or its slot’s health', () => {
    expect(skipReason(state(maya, { stale: 'provider-untrusted' }), undefined, 'Maya')).toBe('You haven’t trusted Maya');
    expect(skipReason(state(cloud), { health: 'unauthorized' } as never, 'OpenRouter')).toBe('Needs signing in again');
    expect(skipReason(state(local), { health: 'unreachable' } as never, 'Local')).toBe('Not answering');
    expect(skipReason(state(local), { health: 'reachable' } as never, 'Local')).toBeNull();
  });

  it('walks the stack without sending: skips, stops for private projects, and leaves the rest unreached', () => {
    const entries = [
      { state: state(local), reason: 'Not answering' },
      { state: state(maya), reason: null },
      { state: state(cloud), reason: null },
    ];
    expect(dryRun(entries, { privateProject: false })).toEqual({
      steps: [{ outcome: 'skipped', reason: 'Not answering' }, { outcome: 'answers' }, { outcome: 'unreached' }],
      answeredBy: 1,
    });
    expect(dryRun(entries, { privateProject: true })).toEqual({
      steps: [{ outcome: 'skipped', reason: 'Not answering' }, { outcome: 'private' }, { outcome: 'private' }],
      answeredBy: null,
    });
  });
});
