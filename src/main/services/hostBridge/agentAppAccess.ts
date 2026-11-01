import type { InferenceChainSlot } from '../../../shared/types/inferenceChain';
import { upstreamIsLocal } from '../assistant/hermesStreamTimeout';

/**
 * Who may use the tools that report on the app itself (ADR 0040). Hermes can't reach either
 * input: the flag is the app's own environment, and the route is what main applied.
 */

/** Decision 1: on for an unpackaged run, and for a packaged one only when asked for at launch. */
export function agentAppAccessEnabled(env: NodeJS.ProcessEnv, isPackaged: boolean): boolean {
  const value = env.BOUNDARY_AGENT_APP_ACCESS;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return !isPackaged;
}

/** One model that could serve the stack's next call. */
export interface RouteEntry {
  slot: InferenceChainSlot;
  modelId: string;
  /** Set for a stored slot. */
  endpoint?: string;
  /** Set for a shared model. */
  providerId?: string;
}

export type RouteCheck = { ok: true } | { ok: false; reason: string };

function refusal(entry: RouteEntry, providerTrusted: (providerId: string) => boolean): string | null {
  const name = entry.modelId || entry.slot;
  if (entry.slot === 'peer') {
    if (entry.providerId && providerTrusted(entry.providerId)) return null;
    return `${name} is shared by a provider who isn't Trusted`;
  }
  if (entry.slot !== 'local') return `${name} is a cloud model`;
  // upstreamIsLocal answers true for a URL it can't read.
  if (!entry.endpoint || !URL.canParse(entry.endpoint)) return `${name} has no readable endpoint`;
  return upstreamIsLocal(entry.endpoint) ? null : `${name} is on a remote host`;
}

/** Decision 2: every entry that could serve must be local, or shared by a Trusted provider. */
export function checkInferenceRoute(
  route: RouteEntry[] | null,
  providerTrusted: (providerId: string) => boolean
): RouteCheck {
  if (!route?.length) return { ok: false, reason: 'No model route is applied.' };
  for (const entry of route) {
    const reason = refusal(entry, providerTrusted);
    if (reason) return { ok: false, reason: `Refused because ${reason}.` };
  }
  return { ok: true };
}
