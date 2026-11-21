import { randomBytes } from 'node:crypto';
import type { CalendarAccess } from '../../../../shared/types/calendars';
import { persistDebugLog } from '../../../persistDebugLog';
import { encryptToBase64, tryDecryptFromBase64 } from '../../secrets/osEncryption';
import { ensureHostBridgeStarted, setCalendarTokens } from '../../hostBridge/hostBridgeService';
import { requireStackCapability } from '../../stackHost/capabilities';
import { removeCalendarEntry, writeCalendarEntry } from './calendarCommon';
import { MAC_ACCOUNT_SLUG, MAC_TOKEN_ENV, macCalendarMcpEntry } from './calendarModel';
import { getMacCalendarAccount, saveCalendarAccount } from './calendarStore';

/**
 * The Mac account's per-agent tokens (ADR 0045): each agent with access holds its own token in
 * its `.env`, and the host bridge maps each token back to its agent.
 */

/** Change the stored account's tokens without touching anything else saved since it was read. */
function updateTokens(edit: (tokens: Record<string, string>) => Record<string, string>): void {
  const account = getMacCalendarAccount();
  if (!account) return;
  saveCalendarAccount({ ...account, agentTokens: edit({ ...account.agentTokens }) });
}

/** The agent's token, made and stored the first time (or when the keychain lost the old one). */
async function agentToken(agentSlug: string): Promise<string> {
  const stored = getMacCalendarAccount()?.agentTokens?.[agentSlug];
  const existing = stored ? await tryDecryptFromBase64(stored) : null;
  if (existing) return existing;
  const token = randomBytes(32).toString('hex');
  const encrypted = await encryptToBase64(token);
  updateTokens((tokens) => ({ ...tokens, [agentSlug]: encrypted }));
  return token;
}

/** Give one agent the Mac's calendars: its token in its `.env`, then its `calendar-mac` entry. */
export async function grantMac(agentSlug: string, access: CalendarAccess): Promise<void> {
  // Agents reach the Mac's calendars through the host bridge on this machine.
  requireStackCapability('hostCallbacks');
  // The bridge first: a grant it refuses (computer access stopped) must not leave a stored token.
  const { mcpPort } = await ensureHostBridgeStarted();
  const token = await agentToken(agentSlug);
  await writeCalendarEntry(
    agentSlug,
    MAC_ACCOUNT_SLUG,
    { envKey: MAC_TOKEN_ENV, value: token },
    macCalendarMcpEntry({ mcpPort, access })
  );
}

/** Take them away: the entry, the `.env` key, then the stored token. */
export async function revokeMac(agentSlug: string): Promise<void> {
  await removeCalendarEntry(agentSlug, MAC_ACCOUNT_SLUG, MAC_TOKEN_ENV);
  updateTokens(({ [agentSlug]: _dropped, ...rest }) => rest);
}

/**
 * Give the bridge the token of every agent with access. Runs after each access change and once
 * at start, after the bridge is up; with no Mac account the map is empty.
 */
export async function syncMacCalendarTokens(): Promise<void> {
  const account = getMacCalendarAccount();
  const map: Record<string, string> = {};
  let unreadable = 0;
  for (const [agentSlug, encrypted] of Object.entries(account?.agentTokens ?? {})) {
    if ((account?.access[agentSlug] ?? 'off') === 'off') continue;
    const token = await tryDecryptFromBase64(encrypted);
    if (token) map[token] = agentSlug;
    else unreadable += 1;
  }
  setCalendarTokens(map);
  if (unreadable) persistDebugLog('calendars', 'mac calendar tokens unreadable', { unreadable });
}
