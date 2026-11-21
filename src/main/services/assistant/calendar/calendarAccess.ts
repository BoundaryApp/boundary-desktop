import type { CalendarAccess, CalendarProgressStep } from '../../../../shared/types/calendars';
import { listStoredAgents } from '../hermes/hermesAgentStore';
import { getHermesGatewaySession } from '../hermes/hermesGatewaySession';
import { reloadMcp, removeCalendarEntry, writeCalendarEntry } from './calendarCommon';
import { calendarMcpEntry, calendarPasswordEnvKey, calendarServerName, expectedToolCount, macToolsForAccess } from './calendarModel';
import type { StoredCalendarAccount } from './calendarStore';
import { grantMac, revokeMac, syncMacCalendarTokens } from './macCalendarTokens';

/** Bringing agents' profiles in line with an account's access levels, for either provider. */

const CONNECT_CHECK_MS = 30_000;

/** Give one agent a CalDAV calendar: the password in its `.env`, then the entry. */
async function grant(account: StoredCalendarAccount, agentSlug: string, access: CalendarAccess, pw: string): Promise<void> {
  const entry = calendarMcpEntry({ slug: account.slug, url: account.url, username: account.username, access });
  await writeCalendarEntry(agentSlug, account.slug, { envKey: calendarPasswordEnvKey(account.slug), value: pw }, entry);
}

export function revoke(slug: string, agentSlug: string): Promise<void> {
  return removeCalendarEntry(agentSlug, slug, calendarPasswordEnvKey(slug));
}

interface McpStatusRow {
  name?: string;
  connected?: boolean;
  status?: string;
  tools?: number;
}

/**
 * Wait for the main agent's profile to report the entry connected with its tools. Agent profiles
 * with no open chat connect at their next session, so only the default profile is checked.
 */
async function checkHermesSees(account: StoredCalendarAccount): Promise<string | null> {
  const builtIn = listStoredAgents().find((a) => a.builtIn)?.slug;
  const access = builtIn ? account.access[builtIn] : undefined;
  if (!builtIn || !access || access === 'off') return null;
  const name = calendarServerName(account.slug);
  const want = account.provider === 'mac' ? macToolsForAccess(access).length : expectedToolCount(access);
  const deadline = Date.now() + CONNECT_CHECK_MS;
  let last: McpStatusRow | undefined;
  while (Date.now() < deadline) {
    const result = (await getHermesGatewaySession().requestMcp('mcp.servers.status', {})) as {
      servers?: McpStatusRow[];
    };
    last = result.servers?.find((s) => s.name === name);
    if (last?.connected && (last.tools ?? 0) >= want) return null;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return last?.status === 'failed'
    ? `Hermes couldn’t connect to ${account.name}. Open a new chat and ask about your calendar to retry.`
    : `Hermes hasn’t connected to ${account.name} yet. It will when you start a new chat.`;
}

/**
 * Bring every agent's profile in line with `next`, then reload once. The Mac account has no
 * password (`pw` is `''`): each granted agent gets its own token, and the bridge gets the new
 * token map before Hermes reconnects.
 */
export async function applyAccess(
  account: StoredCalendarAccount,
  previous: Record<string, CalendarAccess>,
  pw: string,
  progress: (step: CalendarProgressStep) => void
): Promise<string | null> {
  progress('access');
  const mac = account.provider === 'mac';
  const agents = new Set([...Object.keys(previous), ...Object.keys(account.access)]);
  try {
    for (const agentSlug of agents) {
      const level = account.access[agentSlug] ?? 'off';
      if (level === 'off') {
        if (mac) {
          // A token left by an earlier failure goes too.
          if ((previous[agentSlug] ?? 'off') !== 'off' || account.agentTokens?.[agentSlug]) await revokeMac(agentSlug);
        } else if ((previous[agentSlug] ?? 'off') !== 'off') {
          await revoke(account.slug, agentSlug);
        }
      } else if (mac) {
        await grantMac(agentSlug, level);
      } else {
        await grant(account, agentSlug, level, pw);
      }
    }
  } finally {
    // Also after a failed grant or revoke, so the bridge matches the tokens agents now hold.
    if (mac) await syncMacCalendarTokens();
  }
  await reloadMcp();
  progress('checking');
  return checkHermesSees(account);
}
