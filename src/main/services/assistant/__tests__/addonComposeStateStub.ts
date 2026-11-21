import { BOUNDARY_ASSISTANT_COMPOSE_PROFILES, buildComposeProfileArgs } from '../../../../shared/assistantStackConstants';
import type { AddonId } from '../../../../shared/types/addons';

/**
 * `addonComposeState` for a stack with no add-ons on, answered in memory. Its real readers go
 * through the stack's files, whose reads don't settle while fake timers hold the clock.
 */
export async function addonComposeStateStub() {
  const actual = await import('../../addons/addonComposeState');
  return {
    ...actual,
    installedAddonsHere: async (): Promise<AddonId[]> => [],
    installedAddonsAt: async (): Promise<AddonId[]> => [],
    addonComposeProfiles: async (): Promise<string[]> => [],
    boundaryComposeProfileArgs: async () => buildComposeProfileArgs([...BOUNDARY_ASSISTANT_COMPOSE_PROFILES]),
  };
}
