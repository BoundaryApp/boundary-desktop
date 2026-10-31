import type { InferenceChainEntry } from '../../shared/types/inferenceChain';
import type { AppSwitchEvent } from '../../shared/types/onboarding';
import { createIpcStore, useIpcStore } from '../lib/ipcStore';
import { takeInferenceStatus } from './inferenceStatus';

/**
 * The app default change running in main, if any. Main owns it and pushes each stage; a change
 * outlives the Settings screen, so coming back to Settings shows it still running.
 */
// Set while Cancel is on its way to main: a stage already sent mustn't bring the target back.
let cancelling = false;

const store = createIpcStore<AppSwitchEvent>({
  initial: { appSwitch: null },
  start: (self) => {
    window.electronAPI.onboarding.onAppSwitch((event) => {
      if (!(cancelling && event.appSwitch?.phase === 'switching')) self.set(event);
    });
    void window.electronAPI.onboarding.getAppSwitch().then((event) => {
      if (!self.get().appSwitch) self.set(event);
    });
  },
});

export function useAppSwitch(): AppSwitchEvent {
  return useIpcStore(store);
}

/** Show the bar from the click, ahead of main's first stage. */
export function beginAppSwitch(target: InferenceChainEntry, previous: InferenceChainEntry | null): void {
  store.set({ appSwitch: { target, previous, phase: 'switching', stage: 'preparing' } });
}

export function endAppSwitch(): void {
  store.update((event) => ({ ...event, appSwitch: null }));
}

/** The screen goes back to the previous model now; main's events then follow the stack. */
export async function cancelAppSwitch(): Promise<void> {
  cancelling = true;
  store.update(({ appSwitch }) => {
    if (!appSwitch || appSwitch.stage === 'preparing') return { appSwitch: null };
    return {
      appSwitch: {
        ...appSwitch,
        phase: 'reverting',
        restartAgain: appSwitch.stage === 'restarting' || appSwitch.stage === 'starting',
      },
    };
  });
  try {
    await takeInferenceStatus(await window.electronAPI.onboarding.cancelAppSwitch());
  } finally {
    cancelling = false;
  }
}
