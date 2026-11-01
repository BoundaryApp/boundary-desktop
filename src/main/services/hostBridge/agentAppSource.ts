import os from 'node:os';
import { app } from 'electron';
import { isAssistantStackReady } from '../assistant/AssistantStackService';
import { getLastAppliedLlm } from '../assistant/AssistantStackStore';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { sharedModelFacts } from '../circles/circlesService';
import { inferenceRouterChain } from '../inference/inferenceRouterService';
import { getSlotLlmConnection } from '../onboarding/OpenAiOnboardingStore';
import { redactSecrets } from '../secrets/redact';
import { currentUpdateSnapshot } from '../updates/ipcHandlers';
import { readDebugLogTail } from '../../persistDebugLog';
import { agentAppAccessEnabled, checkInferenceRoute, type RouteCheck, type RouteEntry } from './agentAppAccess';
import { getHostToolsState } from './hostBridgeService';
import type { AgentAppSource } from './hostTools';
import { recentProblems } from './recentProblems';

const SCREEN_PART = /^[A-Za-z0-9:_-]{1,60}$/;

let screen: { view: string; sheet: string | null } | null = null;

/** Ids only: the renderer sends no titles or text, and anything else is dropped. */
export function noteAppScreen(next: { view: unknown; sheet: unknown }): void {
  if (typeof next.view !== 'string' || !SCREEN_PART.test(next.view)) return;
  const sheet = typeof next.sheet === 'string' && SCREEN_PART.test(next.sheet) ? next.sheet : null;
  screen = { view: next.view, sheet };
}

/**
 * The models that could serve the stack's next call. A chat send can change the router's chain
 * without an apply, so a routed stack reads the chain itself.
 */
async function appliedRoute(): Promise<RouteEntry[] | null> {
  const applied = getLastAppliedLlm();
  if (!applied) return null;
  if (!applied.routed) {
    return [{ slot: applied.slot, modelId: applied.modelId, endpoint: applied.endpointUrl }];
  }
  const chain = inferenceRouterChain();
  if (!chain) return null;
  const serving = chain.entries.filter((state) => !state.stale || state.stale === 'provider-offline');
  return Promise.all(
    serving.map(async ({ entry, key }): Promise<RouteEntry> => {
      const upstream = chain.upstreams[key];
      const modelId = upstream?.modelId ?? entry.modelId ?? '';
      if (entry.slot === 'peer') {
        return { slot: entry.slot, modelId, ...(entry.peer ? { providerId: entry.peer.providerId } : {}) };
      }
      const endpoint = upstream?.baseUrl || (await getSlotLlmConnection(entry.slot))?.endpointUrl;
      return { slot: entry.slot, modelId, ...(endpoint ? { endpoint } : {}) };
    })
  );
}

function scrub(text: string): string {
  return redactSecrets(text, [os.homedir(), os.hostname(), os.userInfo().username]);
}

export const agentAppSource: AgentAppSource = {
  async check(): Promise<RouteCheck> {
    if (!agentAppAccessEnabled(process.env, app.isPackaged)) {
      return { ok: false, reason: "This tool isn't available in this build." };
    }
    // A developer's own stack keeps its model settings, so Boundary can't tell what serves it.
    if (isLocalAssistantStackMode()) {
      return { ok: false, reason: 'Refused because the model route of a local stack is unknown.' };
    }
    return checkInferenceRoute(await appliedRoute(), sharedModelFacts().providerTrusted);
  },

  async status() {
    const update = currentUpdateSnapshot();
    const route = await appliedRoute();
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      screen,
      stackReady: await isAssistantStackReady(),
      hostTools: getHostToolsState(),
      models: route?.map(({ slot, modelId }) => ({ slot, modelId })) ?? [],
      update: update ? { phase: update.phase, channel: update.channel, offered: update.version } : null,
    };
  },

  problems: () => recentProblems(readDebugLogTail().contents, scrub),
};
