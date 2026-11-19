import { randomBytes } from 'node:crypto';
import type {
  CalendarAccess,
  CalendarAccountView,
  CalendarActionResult,
  CalendarProgressStep,
  CalendarTestResult,
  MacAccess,
  MacCalendarsPayload,
  MacCalendarSummary,
  MacConnectPayload,
  MacStatusResult,
} from '../../../../shared/types/calendars';
import { APP_NAME } from '../../../../shared/buildIdentity';
import { persistDebugLog } from '../../../persistDebugLog';
import { encryptToBase64, isOsEncryptionAvailable, tryDecryptFromBase64 } from '../../secrets/osEncryption';
import { ensureHostBridgeStarted, setCalendarTokens, syncHostToolListing } from '../../hostBridge/hostBridgeService';
import { MAC_ACCOUNT_NAME, MAC_ACCOUNT_SLUG, MAC_TOKEN_ENV, macCalendarMcpEntry } from './calendarModel';
import {
  getCalendarAccount,
  getMacCalendarAccount,
  saveCalendarAccount,
  toCalendarAccountView,
  type StoredCalendarAccount,
} from './calendarStore';
import {
  applyAccess,
  broadcastProgress,
  CalendarInputError,
  cleanAccess,
  connectFailure,
  errorText,
  removeCalendarEntry,
  serial,
  writeCalendarEntry,
} from './calendarService';
import { getMacCalendarHelper } from './macCalendarHelper';
import { MacHelperError } from './macCalendarProtocol';

/**
 * The Mac account (ADR 0045, spec decisions 10–16): the Mac's calendars, reached through the
 * calendar helper and the host bridge's `/calendar` route. Each agent with access gets a
 * `calendar-mac` entry and its own token; the bridge maps each token to its agent. The allowed
 * calendars are one list for the account, read by the bridge on every call, so changing it
 * touches nothing in Hermes.
 *
 * Logs hold agent slugs, counts and statuses. Never calendar titles.
 */

const HELPER_MISSING = `The calendar helper isn’t installed. Reinstall ${APP_NAME} and try again.`;
const HELPER_STOPPED = 'The calendar helper stopped.';
const NO_ACCESS = `${APP_NAME} doesn’t have access to the calendars on this Mac.`;
const NOT_CONNECTED = 'Calendars on this Mac aren’t connected.';

function isHelperDown(error: unknown): error is MacHelperError & { code: 'missing' | 'stopped' } {
  return error instanceof MacHelperError && (error.code === 'missing' || error.code === 'stopped');
}

/**
 * Drop allowed calendars the Mac no longer has and refresh the remembered titles. Returns the
 * dropped calendars' titles, for the card.
 */
function dropMissingCalendars(calendars: readonly MacCalendarSummary[]): string[] {
  const account = getMacCalendarAccount();
  if (!account) return [];
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const allowed = account.allowedCalendarIds ?? [];
  const kept = allowed.filter((id) => byId.has(id));
  const dropped = allowed.filter((id) => !byId.has(id)).map((id) => account.allowedCalendarTitles?.[id] ?? '');
  const titles = Object.fromEntries(kept.map((id) => [id, byId.get(id)!.title]));
  const titlesChanged = JSON.stringify(titles) !== JSON.stringify(account.allowedCalendarTitles ?? {});
  if (dropped.length || titlesChanged) {
    saveCalendarAccount({ ...account, allowedCalendarIds: kept, allowedCalendarTitles: titles });
  }
  if (dropped.length) persistDebugLog('calendars', 'mac calendars dropped', { dropped: dropped.length, kept: kept.length });
  return dropped.filter(Boolean);
}

/** Ask the helper for access (`status` or `requestAccess`), then list the calendars if granted. */
async function askHelper(op: 'status' | 'requestAccess'): Promise<MacStatusResult> {
  const helper = getMacCalendarHelper();
  const state = helper.state();
  if (state === 'missing' || state === 'stopped') return { access: state, calendars: [] };
  try {
    const { access } = await helper.request<{ access: MacAccess }>(op);
    if (access !== 'granted') return { access, calendars: [] };
    const calendars = await helper.request<MacCalendarSummary[]>('listCalendars');
    const dropped = dropMissingCalendars(calendars);
    return { access, calendars, ...(dropped.length ? { dropped } : {}) };
  } catch (error) {
    if (isHelperDown(error)) return { access: error.code, calendars: [] };
    throw error;
  }
}

/** The Mac's calendar permission and, once granted, its calendars. */
export function macCalendarStatus(): Promise<MacStatusResult> {
  return askHelper('status');
}

/** **Restart** on the card: a fresh helper with its crash count cleared, then its status. */
export function restartMacCalendarHelper(): Promise<MacStatusResult> {
  const helper = getMacCalendarHelper();
  helper.restart();
  persistDebugLog('calendars', 'mac calendar helper restarted', { state: helper.state() });
  return macCalendarStatus();
}

/** **Allow calendar access**: macOS asks the person, so this waits for their answer. */
export function requestMacCalendarAccess(): Promise<MacStatusResult> {
  return askHelper('requestAccess');
}

/** The Mac's calendars, or a refusal saying why they can't be listed. */
async function grantedCalendars(): Promise<MacCalendarSummary[]> {
  const status = await macCalendarStatus();
  if (status.access === 'missing') throw new CalendarInputError(HELPER_MISSING);
  if (status.access === 'stopped') throw new CalendarInputError(HELPER_STOPPED);
  if (status.access !== 'granted') throw new CalendarInputError(NO_ACCESS);
  return status.calendars;
}

/** The ticked ids the Mac has, with their titles. At least one must be left. */
function allowedFrom(value: unknown, calendars: readonly MacCalendarSummary[]): { ids: string[]; titles: Record<string, string> } {
  const wanted = new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  const chosen = calendars.filter((c) => wanted.has(c.id));
  if (!chosen.length) throw new CalendarInputError('Choose at least one calendar.');
  return { ids: chosen.map((c) => c.id), titles: Object.fromEntries(chosen.map((c) => [c.id, c.title])) };
}

async function macView(account: StoredCalendarAccount, calendars: MacCalendarSummary[]): Promise<CalendarAccountView> {
  return { ...(await toCalendarAccountView(account)), macCalendars: calendars };
}

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

/** **Test** on the card: the Mac's calendar permission, in the shape of a sign-in test. */
export async function checkMacAccess(): Promise<CalendarTestResult> {
  try {
    const status = await macCalendarStatus();
    if (status.access === 'granted') return { status: 'ok', url: '', calendars: [] };
    if (status.access === 'missing') return { status: 'unreachable', error: HELPER_MISSING };
    if (status.access === 'stopped') return { status: 'unreachable', error: HELPER_STOPPED };
    return { status: 'rejected' };
  } catch (error) {
    return { status: 'error', error: errorText(error) };
  }
}

export function connectMacCalendars(payload: MacConnectPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    let saved: StoredCalendarAccount | null = null;
    try {
      if (!(await isOsEncryptionAvailable())) {
        throw new CalendarInputError(`${APP_NAME} can’t keep calendar keys on this Mac because the keychain isn’t available.`);
      }
      const taken = getMacCalendarAccount() ?? getCalendarAccount(MAC_ACCOUNT_SLUG);
      if (taken?.provider === 'mac') throw new CalendarInputError('Calendars on this Mac are already connected.');
      if (taken) throw new CalendarInputError(`Rename or remove the calendar called ${taken.name} first.`);
      const calendars = await grantedCalendars();
      const allowed = allowedFrom(payload?.allowedCalendarIds, calendars);
      const access = cleanAccess(payload?.access);
      const progress = (step: CalendarProgressStep) => broadcastProgress({ slug: MAC_ACCOUNT_SLUG, step });

      progress('saving');
      const at = new Date().toISOString();
      saved = {
        slug: MAC_ACCOUNT_SLUG,
        name: MAC_ACCOUNT_NAME,
        provider: 'mac',
        url: '',
        username: '',
        password: '',
        calendars: [],
        access,
        createdAt: at,
        lastCheck: { at, status: 'ok' },
        lastOkAt: at,
        allowedCalendarIds: allowed.ids,
        allowedCalendarTitles: allowed.titles,
        agentTokens: {},
      };
      saveCalendarAccount(saved);
      // offer_setup leaves the bridge's list; the reload in applyAccess makes Hermes list it again.
      syncHostToolListing();
      const warning = await applyAccess(saved, {}, '', progress);
      progress('done');
      persistDebugLog('calendars', 'mac calendars connected', {
        agents: Object.entries(access).filter(([, v]) => v !== 'off').map(([k]) => k),
        calendars: allowed.ids.length,
      });
      const account = getMacCalendarAccount() ?? saved;
      return { success: true, account: await macView(account, calendars), ...(warning ? { error: warning } : {}) };
    } catch (error) {
      return connectFailure(saved, errorText(error));
    }
  });
}

/** **Edit calendars**: a new allowed list. Agents see it on their next call. */
export function setMacCalendars(payload: MacCalendarsPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    try {
      if (!getMacCalendarAccount()) throw new CalendarInputError(NOT_CONNECTED);
      const calendars = await grantedCalendars();
      const allowed = allowedFrom(payload?.allowedCalendarIds, calendars);
      const account = getMacCalendarAccount();
      if (!account) throw new CalendarInputError(NOT_CONNECTED);
      const next: StoredCalendarAccount = { ...account, allowedCalendarIds: allowed.ids, allowedCalendarTitles: allowed.titles };
      saveCalendarAccount(next);
      persistDebugLog('calendars', 'mac calendars chosen', { calendars: allowed.ids.length });
      return { success: true, account: await macView(next, calendars) };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  });
}
