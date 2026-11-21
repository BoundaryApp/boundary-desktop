import {
  ALL_STACK_CAPABILITIES,
  STACK_CAPABILITY_MISSING_TEXT,
  type StackCapability,
  type StackHostCapabilities,
} from '../../shared/stackCapabilities';
import { Callout } from '../components/ui/alert';
import { createIpcStore, useIpcStore } from '../lib/ipcStore';

/**
 * What the stack host can do (ADR 0062 §4), asked of main once. Until main answers, and when the
 * bridge has no such call (tests that stub only part of it), every capability counts as present,
 * as on the local host.
 */
const capabilitiesStore = createIpcStore<StackHostCapabilities>({
  initial: ALL_STACK_CAPABILITIES,
  start: (store) => {
    const ask = window.electronAPI?.assistantStack?.getCapabilities;
    if (typeof ask !== 'function') return;
    void Promise.resolve()
      .then(() => ask())
      .then((capabilities) => {
        if (capabilities) store.set(capabilities);
      })
      .catch((): void => undefined);
  },
});

export function useStackCapability(capability: StackCapability): boolean {
  return useIpcStore(capabilitiesStore)[capability];
}

/** @internal Vitest only: capabilities as if main had sent them. */
export function setStackCapabilitiesForTests(capabilities: Partial<StackHostCapabilities>): void {
  capabilitiesStore.setForTests({ ...ALL_STACK_CAPABILITIES, ...capabilities });
}

/** Why a feature isn't here, shown where the feature would be. */
export function StackCapabilityNote({
  capability,
  size,
  className,
}: {
  capability: StackCapability;
  size?: 'default' | 'sm';
  className?: string;
}) {
  return (
    <Callout variant="info" size={size} className={className}>
      {STACK_CAPABILITY_MISSING_TEXT[capability]}
    </Callout>
  );
}
