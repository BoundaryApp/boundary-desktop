import type { CalendarAccess, CalendarActionResult, CalendarProgressEvent } from '../../../../shared/types/calendars';
import { createSerialQueue } from '../../../../shared/utils/serialQueue';
import { persistDebugLog } from '../../../persistDebugLog';
import { broadcast } from '../../windows';
import { editProfileEnvs } from '../../hostBridge/hermesProvision';
import { getStackFiles } from '../../stackHost/activeStack';
import { getAssistantStackAccess } from '../AssistantStackService';
import { buildHermesConfigSetExec } from '../hermesConfigSetExec';
import { removeEnvLines, upsertEnvLines } from '../stackEnv';
import { resolveProfileForAgent } from '../hermes/hermesAgents';
import { listStoredAgents } from '../hermes/hermesAgentStore';
import { getHermesGatewaySession } from '../hermes/hermesGatewaySession';
import { JsonRpcGatewayError } from '../hermes/vendor/json-rpc-channel';
import { gatewayErrorText } from '../hermes/gatewayErrorText';
import { calendarServerName } from './calendarModel';
import { toCalendarAccountView, type StoredCalendarAccount } from './calendarStore';

/**
 * Pieces both calendar providers use: input refusals and error text, the one-at-a-time queue,
 * progress events, and writing or removing an agent's calendar entry in its Hermes profile.
 */

/** `change` is safe to offer because every entry is `trust: untrusted` (spec decision 6). */
const OFFERED_ACCESS: ReadonlySet<CalendarAccess> = new Set(['off', 'read', 'change']);

/** A refusal whose message is shown as-is. */
export class CalendarInputError extends Error {}

export function errorText(err: unknown, secrets: readonly string[] = []): string {
  if (err instanceof CalendarInputError) return err.message;
  return gatewayErrorText(err, secrets, {
    methodMissing: 'This version of Hermes can’t manage MCP servers. Update the agent stack and try again.',
    fallback: 'Something went wrong.',
    maxLength: 400,
  });
}

/** Access for known agents only, limited to the offered levels; everyone else is off. */
export function cleanAccess(value: unknown): Record<string, CalendarAccess> {
  const known = new Set(listStoredAgents().map((a) => a.slug));
  const out: Record<string, CalendarAccess> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [slug, level] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(slug)) continue;
    if (typeof level === 'string' && OFFERED_ACCESS.has(level as CalendarAccess)) {
      out[slug] = level as CalendarAccess;
    }
  }
  return out;
}

export function broadcastProgress(event: CalendarProgressEvent): void {
  broadcast('calendars:progress', event);
}

/** One change at a time: two writes to the same profile files must not interleave. */
export const serial = createSerialQueue();

function profileFor(agentSlug: string): string {
  return resolveProfileForAgent(agentSlug) ?? '';
}

function profileParams(profile: string): Record<string, unknown> {
  return profile ? { profile } : {};
}

async function editProfileEnv(profile: string, edit: (current: string) => string): Promise<boolean> {
  const { written } = await editProfileEnvs(getStackFiles(), [profile], edit);
  return written.length > 0;
}

/**
 * Give one agent a calendar entry: the secret its header names into the agent's `.env`, then the
 * `calendar-<slug>` entry. Does nothing when the agent's profile folder is gone.
 */
export async function writeCalendarEntry(
  agentSlug: string,
  slug: string,
  secret: { envKey: string; value: string },
  entry: Record<string, unknown>
): Promise<void> {
  const { compose } = getAssistantStackAccess();
  const profile = profileFor(agentSlug);
  const written = await editProfileEnv(profile, (current) =>
    upsertEnvLines(current, { [secret.envKey]: secret.value })
  );
  if (!written) return;
  // The entry names the secret's env key, not the value; it still goes through the environment
  // so the username and URL stay off the command line.
  const { args, env } = buildHermesConfigSetExec(
    profile,
    `mcp_servers.${calendarServerName(slug)}`,
    JSON.stringify(entry),
    { secret: true }
  );
  await compose(args, { timeout: 60_000, env });
}

/** Take a calendar entry away from one agent: the entry, then the secret's env key. */
export async function removeCalendarEntry(agentSlug: string, slug: string, envKey: string): Promise<void> {
  const profile = profileFor(agentSlug);
  try {
    await getHermesGatewaySession().requestMcp('mcp.servers.remove', {
      ...profileParams(profile),
      name: calendarServerName(slug),
    });
  } catch (error) {
    // A missing entry is what we want; anything else is reported.
    if (!(error instanceof JsonRpcGatewayError) || !/not found/i.test(error.message)) throw error;
  }
  // mcp.servers.remove leaves the key behind (spec Phase 0, S5).
  await editProfileEnv(profile, (current) => removeEnvLines(current, [envKey]));
}

export async function reloadMcp(): Promise<void> {
  await getHermesGatewaySession().requestMcp('reload.mcp', { confirm: true });
}

/** A connect's result when it failed, saying so when the account was saved before the failure. */
export async function connectFailure(saved: StoredCalendarAccount | null, message: string): Promise<CalendarActionResult> {
  if (!saved) return { success: false, error: message };
  persistDebugLog('calendars', 'calendar saved but not given to every agent', { slug: saved.slug, error: message });
  return {
    success: false,
    account: await toCalendarAccountView(saved),
    error: `${saved.name} is saved, but not every agent has it yet. ${message} Use Change access to try again.`,
  };
}
