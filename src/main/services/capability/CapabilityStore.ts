import Store from 'electron-store';
import type { CapabilityAssessment, CapabilityStatus } from '../../../shared/types/capability';

interface CapabilityStoreShape {
  acknowledged: boolean;
  lastAssessment: CapabilityAssessment | null;
}

const store = new Store<CapabilityStoreShape>({
  name: 'host-capability',
  defaults: {
    acknowledged: false,
    lastAssessment: null,
  },
});

export function getCapabilityStatus(): CapabilityStatus {
  return {
    acknowledged: Boolean(store.get('acknowledged')),
    lastAssessment: store.get('lastAssessment') ?? null,
  };
}

export function setLastAssessment(assessment: CapabilityAssessment): void {
  store.set('lastAssessment', assessment);
  // Keep prior acknowledge so users who continued despite warnings are not re-blocked
  // on relaunch when resources are still below the recommended floor.
}

export function acknowledgeCapability(): { success: boolean; error?: string } {
  const last = store.get('lastAssessment');
  if (!last) {
    return {
      success: false,
      error: 'Acknowledge requires a host capability assessment first.',
    };
  }
  store.set('acknowledged', true);
  return { success: true };
}
