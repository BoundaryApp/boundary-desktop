import type { InferenceChainEntry } from '../../../shared/types/inferenceChain';
import type {
  AppSwitchEvent,
  AppSwitchResult,
  AppSwitchStage,
  AppSwitchState,
  InferenceStatusResult,
} from '../../../shared/types/onboarding';
import { persistDebugLog } from '../../persistDebugLog';
import { broadcast } from '../windows';
import { getLastAppliedLlm } from '../assistant/AssistantStackStore';
import {
  type AppInferenceChoice,
  getOpenAiOnboardingStatus,
  getSlotLlmConnection,
  readAppInferenceChoice,
  restoreAppInferenceChoice,
} from './OpenAiOnboardingStore';

/**
 * One change of the app default at a time, from Settings. The store changes first, then the stack
 * follows through the apply queue, so a cancel goes through that queue too: there is never a second
 * apply racing the first. What Cancel can promise depends on the stage:
 *
 * - `preparing`: nothing has changed yet, so the store goes back and that is all.
 * - `applying`: the run stops before any restart. The next run points the proxy back and restores
 *   the settings, with no restart, because the running Hermes never read the new ones.
 * - `restarting`, `starting`: a restart can't be stopped safely, so it ends and Hermes restarts
 *   again on the previous model. Chats wait for that (`settleHermesApply`).
 */
interface ActiveSwitch {
  state: AppSwitchState;
  controller: AbortController;
  prior: AppInferenceChoice;
  /** Hermes is running the previous default, so undoing unread settings needs no restart. */
  priorIsApplied: boolean;
}

let active: ActiveSwitch | null = null;

function publish(event: AppSwitchEvent): void {
  broadcast('onboarding:app-switch', event);
}

function update(mine: ActiveSwitch, state: AppSwitchState): void {
  mine.state = state;
  publish({ appSwitch: state });
}

function finish(mine: ActiveSwitch, error?: string): void {
  if (active === mine) active = null;
  publish({ appSwitch: null, ...(error ? { error } : {}) });
}

async function isApplied({ appDefault, shared }: AppInferenceChoice): Promise<boolean> {
  const last = getLastAppliedLlm();
  if (!last) return false;
  if (shared) return last.slot === 'peer' && last.modelId === shared.modelId;
  if (!appDefault || last.slot !== appDefault) return false;
  return (await getSlotLlmConnection(appDefault))?.modelId === last.modelId;
}

export function currentAppSwitch(): AppSwitchEvent {
  return { appSwitch: active?.state ?? null };
}

/**
 * Store a new app default with `write`, then move the stack to it. A running reply keeps the stack
 * as it is, since a restart or a new proxy upstream would cut it off; the next send applies the
 * default, as `ensureResolvedInferenceReady` does for any change.
 */
export async function switchAppInference(
  target: InferenceChainEntry,
  write: () => Promise<AppSwitchResult>
): Promise<AppSwitchResult> {
  if (active) {
    return { success: false, error: 'The app default is still changing.', status: await getOpenAiOnboardingStatus() };
  }
  const prior = readAppInferenceChoice();
  const previous = prior.shared ?? (prior.appDefault ? { slot: prior.appDefault } : null);
  const mine: ActiveSwitch = {
    state: { target, previous, phase: 'switching', stage: 'preparing' },
    controller: new AbortController(),
    prior,
    priorIsApplied: false,
  };
  active = mine;
  publish({ appSwitch: mine.state });
  const { signal } = mine.controller;
  const cancelled = async (): Promise<AppSwitchResult> => ({
    success: true,
    cancelled: true,
    status: await getOpenAiOnboardingStatus(),
  });
  try {
    mine.priorIsApplied = await isApplied(prior);
    const result = await write();
    // Cancel may have put the choice back while `write` was on its way to storing the new one.
    if (signal.aborted) {
      restoreAppInferenceChoice(prior);
      return await cancelled();
    }
    if (!result.success) {
      finish(mine);
      return result;
    }
    const { listRunningTurns } = await import('../assistant/hermes/hermesRunningTurns');
    if (listRunningTurns().length > 0) {
      finish(mine);
      return { ...result, deferred: true };
    }
    const { applyLlmConnectionToHermes, isAssistantStackReady } = await import('../assistant/AssistantStackService');
    if (!(await isAssistantStackReady())) {
      if (active === mine && !signal.aborted) finish(mine);
      return signal.aborted ? await cancelled() : result;
    }
    const applied = await applyLlmConnectionToHermes(undefined, {
      signal,
      onStage: (stage: AppSwitchStage) => {
        if (active === mine && mine.state.phase === 'switching') update(mine, { ...mine.state, stage });
      },
    });
    if (signal.aborted) return await cancelled();
    finish(mine);
    return applied.success ? result : { ...result, applyError: applied.error ?? 'The assistant didn’t switch.' };
  } catch (error) {
    if (active === mine) finish(mine);
    throw error;
  }
}

async function revert(mine: ActiveSwitch): Promise<void> {
  const { applyLlmConnectionToHermes } = await import('../assistant/AssistantStackService');
  const applied = await applyLlmConnectionToHermes(undefined, {
    restoresRunningHermes: mine.priorIsApplied,
    onStage: (stage) => update(mine, { ...mine.state, stage }),
  });
  finish(
    mine,
    applied.success ? undefined : `The previous model is saved, but the assistant didn’t go back to it: ${applied.error}`
  );
  broadcast('onboarding:status', await getOpenAiOnboardingStatus());
}

/** Put the previous default back at once; the stack follows through the apply queue. */
export async function cancelAppSwitch(): Promise<InferenceStatusResult> {
  const mine = active;
  if (mine && mine.state.phase === 'switching') {
    const { stage } = mine.state;
    restoreAppInferenceChoice(mine.prior);
    mine.controller.abort();
    const restartAgain = stage === 'restarting' || stage === 'starting';
    persistDebugLog('assistant-stack', 'App default switch cancelled', { stage, restartAgain });
    if (stage === 'preparing' || !mine.state.previous) {
      finish(mine);
    } else {
      update(mine, { ...mine.state, phase: 'reverting', restartAgain });
      void revert(mine);
    }
  }
  return { success: true, status: await getOpenAiOnboardingStatus() };
}
