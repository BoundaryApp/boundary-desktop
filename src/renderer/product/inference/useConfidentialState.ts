import { useEffect, useState } from 'react';
import type { PoolSettings, TrustLevel } from '../../../shared/types/confidential';
import type { AddProviderResult, ConfidentialState, PoolRanking } from '../../../shared/types/confidentialState';
import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import { inferenceSlotLabel } from '../../../shared/inferenceDisplay';
import { createIpcStore, useIpcStore } from '../../lib/ipcStore';
import type { PoolContext } from './entries';

/**
 * The confidential pool's providers, models and settings (ADR 0047 phase 3). `state` is null
 * until main answers. Main sends the new state after every change, so the calls below return
 * nothing the screen has to apply itself.
 */
const store = createIpcStore<ConfidentialState | null>({
  initial: null,
  start(self) {
    const { confidential } = window.electronAPI;
    // Subscribe first so a change during the initial read isn't lost.
    let current = true;
    confidential.onState((next) => {
      current = false;
      self.set(next);
    });
    void confidential
      .getState()
      .then((initial): void => {
        if (current) self.set(initial);
      })
      .catch((): void => undefined);
  },
});

export interface ConfidentialStateApi {
  state: ConfidentialState | null;
  addProvider: (id: string, apiKey: string) => Promise<AddProviderResult>;
  removeProvider: (id: string) => Promise<ConfidentialState>;
  setSettings: (settings: PoolSettings) => Promise<ConfidentialState>;
  rank: (modelId: string, opts: { privateProject: boolean; projectFloor?: TrustLevel }) => Promise<PoolRanking | null>;
  /** Reads each added provider’s balance and hardware check again. */
  refresh: () => Promise<ConfidentialState>;
}

export function useConfidentialState(): ConfidentialStateApi {
  const state = useIpcStore(store);
  const { confidential } = window.electronAPI;
  return {
    state,
    addProvider: (id, apiKey) => confidential.addProvider({ id, apiKey }),
    removeProvider: (id) => confidential.removeProvider({ id }),
    setSettings: (settings) => confidential.setSettings(settings),
    rank: (modelId, opts) => confidential.rank({ modelId, ...opts }),
    refresh: () => confidential.refresh(),
  };
}

interface RankOptions {
  privateProject: boolean;
  projectFloor?: TrustLevel;
}

/**
 * Pool rankings by model id for `modelIds`, asked again whenever the pool's state changes (a
 * provider or a setting). A model is missing until its first answer; later answers replace the
 * last one in place, so a re-rank doesn't blank what's shown. A failed call leaves it missing.
 */
export function usePoolRankings(
  state: ConfidentialState | null,
  modelIds: string[],
  { privateProject, projectFloor }: RankOptions
): Record<string, PoolRanking | null> {
  const [rankings, setRankings] = useState<Record<string, PoolRanking | null>>({});
  const ids = modelIds.join('\n');
  useEffect(() => {
    if (state?.enabled !== true || !ids) return;
    let live = true;
    for (const modelId of ids.split('\n')) {
      void window.electronAPI.confidential
        .rank({ modelId, privateProject, ...(projectFloor ? { projectFloor } : {}) })
        .then((ranking): void => {
          if (live) setRankings((before) => ({ ...before, [modelId]: ranking }));
        })
        .catch((): void => undefined);
    }
    return () => {
      live = false;
    };
  }, [state, ids, privateProject, projectFloor]);
  return rankings;
}

/**
 * Whether each pool among `entries` serves a private project now, by model id. Ranked as main
 * plans a privacy-locked chat: at `projectFloor`, else Pool settings' private minimum (ADR 0047
 * §8). A pool is missing until its answer comes, which reads as not private.
 */
export function usePoolPrivacy(
  state: ConfidentialState | null,
  entries: InferenceChainEntry[],
  projectFloor?: TrustLevel
): Record<string, boolean> {
  const ids = [
    ...new Set(entries.flatMap((entry) => (entry.slot === 'confidential' && entry.modelId?.trim() ? [entry.modelId.trim()] : []))),
  ];
  const floor = projectFloor ?? (state?.enabled === true ? state.settings.privateFloor : undefined);
  const rankings = usePoolRankings(state, ids, { privateProject: true, ...(floor ? { projectFloor: floor } : {}) });
  return Object.fromEntries(Object.entries(rankings).map(([modelId, ranking]) => [modelId, Boolean(ranking?.serving.length)]));
}

/** What a stack needs to name, rank and judge its pools, or undefined when pools are off. */
export function poolContext(
  state: ConfidentialState | null,
  rankings?: Record<string, PoolRanking | null>,
  servesPrivate?: Record<string, boolean>
): PoolContext | undefined {
  if (state?.enabled !== true) return undefined;
  return {
    models: state.models,
    providers: state.providers,
    ...(rankings ? { rankings } : {}),
    ...(servesPrivate ? { servesPrivate } : {}),
  };
}

/** A pool model's name from Boundary's provider list; its id until the list has loaded. */
export function poolModelName(state: ConfidentialState | null, modelId: string): string {
  return (state?.enabled && state.models.find((model) => model.id === modelId)?.name) || modelId;
}

/** A pool as chat titles it before a turn is served, named as its rung names it. */
export function poolTitle(state: ConfidentialState | null, modelId: string): string {
  return `${inferenceSlotLabel('confidential')} · ${poolModelName(state, modelId)}`;
}
