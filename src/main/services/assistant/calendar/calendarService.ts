import type {
  CalendarAccessPayload,
  CalendarActionResult,
  CalendarConnectPayload,
  CalendarListResult,
  CalendarPrepareResult,
  CalendarProgressStep,
  CalendarReplacePasswordPayload,
  CalendarSlugPayload,
  CalendarTestPayload,
  CalendarTestResult,
} from '../../../../shared/types/calendars';
import { persistDebugLog } from '../../../persistDebugLog';
import { getAssistantStackAccess, isAssistantStackReady } from '../AssistantStackService';
import { redactSecrets } from '../../secrets/redact';
import { broadcast } from '../../windows';
import { encryptToBase64, isOsEncryptionAvailable } from '../../secrets/osEncryption';
import { syncHostToolListing } from '../../hostBridge/hostBridgeService';
import { listStoredAgents } from '../hermes/hermesAgentStore';
import { caldavProbeArgs, caldavProbeInput, parseCaldavProbeOutput } from './caldavProbe';
import {
  CALDAV_MCP_SERVICE,
  CALENDAR_COMPOSE_PROFILE,
  calendarPasswordProblem,
  calendarSlug,
  isCalendarProvider,
  MAC_ACCOUNT_SLUG,
  normalizeCalendarUrl,
} from './calendarModel';
import { applyAccess, revoke } from './calendarAccess';
import {
  broadcastProgress,
  CalendarInputError,
  cleanAccess,
  connectFailure,
  errorText,
  reloadMcp,
  serial,
} from './calendarCommon';
import { checkMacAccess } from './macCalendarAccount';
import { revokeMac, syncMacCalendarTokens } from './macCalendarTokens';
import {
  decryptCalendarPassword,
  deleteCalendarAccount,
  getCalendarAccount,
  hasCalDavAccounts,
  listCalendarAccounts,
  saveCalendarAccount,
  lastWorkedAt,
  toCalendarAccountView,
  type StoredCalendarAccount,
} from './calendarStore';
import { APP_NAME } from '../../../../shared/buildIdentity';

/**
 * Settings → Calendars (docs/calendar-ux-study/spec.md, Phases 1 and 2). Boundary writes each calendar
 * into the profiles of the agents that may use it, the way it provisions the host bridge: the
 * password into the profile's `.env`, the `calendar-<slug>` entry with `hermes config set`. Hermes
 * connects new sessions to it on its own, and `reload.mcp` brings open chats and changed entries up
 * to date, so nothing restarts.
 *
 * Payloads carry a password. Never log a payload, and scrub the password from any error text.
 */

const MAX_TEXT = 512;
/** caldav-mcp is built from source on first start (about 2.5 min on an M-series Mac). */
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
/** The background sign-in check (spec Phase 2, item 3). */
const DAILY_CHECK_MS = 24 * 60 * 60_000;
const DAILY_CHECK_TICK_MS = 60 * 60_000;
const FIRST_DAILY_CHECK_MS = 2 * 60_000;

function text(value: unknown, what: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new CalendarInputError(`Enter ${what}.`);
  if (v.length > MAX_TEXT) throw new CalendarInputError(`That ${what} is too long.`);
  return v;
}

function password(value: unknown): string {
  const v = typeof value === 'string' ? value : '';
  const problem = calendarPasswordProblem(v);
  if (problem) throw new CalendarInputError(problem);
  if (v.length > MAX_TEXT) throw new CalendarInputError('That password is too long.');
  return v;
}

/** Tell an open Calendars tab that a background check changed a card. */
function broadcastChanged(): void {
  broadcast('calendars:changed');
}

/**
 * The start-up token sync for the bridge's `/calendar` route, queued behind an access change that
 * is already running so the two don't hand the bridge different maps. A failure is logged by
 * error name only, since an error message could quote a token.
 */
export function syncMacCalendarTokensAtLaunch(sync: () => Promise<void> = syncMacCalendarTokens): Promise<void> {
  return serial(sync).catch((error: unknown) => {
    persistDebugLog('calendars', 'mac calendar token sync failed at launch', {
      error: error instanceof Error ? error.name : 'unknown',
    });
  });
}

// ─── caldav-mcp ───────────────────────────────────────────────────────────────

let preparing: Promise<CalendarPrepareResult> | null = null;

/**
 * Start caldav-mcp (building it the first time). The connect sheet calls this once a CalDAV
 * provider is chosen, so the build overlaps with fetching an app password and signing in.
 */
export function prepareCalendarService(): Promise<CalendarPrepareResult> {
  preparing ??= (async (): Promise<CalendarPrepareResult> => {
    try {
      if (!(await isAssistantStackReady())) {
        return { success: false, error: 'Start the agent stack first.' };
      }
      const { compose } = getAssistantStackAccess();
      await compose(['--profile', CALENDAR_COMPOSE_PROFILE, 'up', '-d', CALDAV_MCP_SERVICE], {
        timeout: PREPARE_TIMEOUT_MS,
      });
      persistDebugLog('calendars', 'calendar service started', {});
      return { success: true };
    } catch (error) {
      const message = errorText(error);
      persistDebugLog('calendars', 'calendar service not started', { error: message });
      return { success: false, error: `Couldn’t start the calendar service. ${message}` };
    }
  })();
  const current = preparing;
  // Keep a success; let a failure be retried by the next call.
  void current.then((result) => {
    if (!result.success && preparing === current) preparing = null;
  });
  return current;
}

/** Forget a started calendar service, so the next prepare starts it again. Tests only. */
export function resetCalendarServiceForTests(): void {
  preparing = null;
}

async function runProbe(creds: { url: string; username: string; password: string }): Promise<CalendarTestResult> {
  const prepared = await prepareCalendarService();
  if (!prepared.success) return { status: 'error', error: prepared.error ?? 'The calendar service isn’t running.' };
  const { composeWithInput } = getAssistantStackAccess();
  const out = await composeWithInput(caldavProbeArgs(), caldavProbeInput(creds), { timeout: PROBE_TIMEOUT_MS });
  const result = parseCaldavProbeOutput(out.stdout, creds.password);
  if (result.status === 'error') {
    persistDebugLog('calendars', 'sign-in test failed to run', {
      code: out.code,
      stderr: redactSecrets(out.stderr, [creds.password]).slice(-400),
    });
  }
  return result;
}

export async function testCalendarSignIn(payload: CalendarTestPayload): Promise<CalendarTestResult> {
  let pw = '';
  try {
    if (!isCalendarProvider(payload?.provider)) throw new CalendarInputError('Choose a provider.');
    const url = normalizeCalendarUrl(payload.provider, typeof payload.url === 'string' ? payload.url : '');
    if (!url) throw new CalendarInputError('Enter the server address.');
    const username = text(payload.username, 'the username');
    pw = password(payload.password);
    return await runProbe({ url, username, password: pw });
  } catch (error) {
    return { status: 'error', error: errorText(error, [pw]) };
  }
}


// ─── IPC-facing operations ────────────────────────────────────────────────────

export async function listCalendars(): Promise<CalendarListResult> {
  try {
    return { success: true, accounts: await Promise.all(listCalendarAccounts().map(toCalendarAccountView)) };
  } catch (error) {
    return { success: false, accounts: [], error: errorText(error) };
  }
}

export function connectCalendar(payload: CalendarConnectPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    let pw = '';
    let saved: StoredCalendarAccount | null = null;
    try {
      if (!(await isOsEncryptionAvailable())) {
        throw new CalendarInputError(`${APP_NAME} can’t store passwords on this Mac because the keychain isn’t available.`);
      }
      if (!isCalendarProvider(payload?.provider)) throw new CalendarInputError('Choose a provider.');
      const name = text(payload.name, 'a name');
      const slug = calendarSlug(name);
      if (!slug) throw new CalendarInputError('Give it a name with at least one letter or number.');
      if (slug === MAC_ACCOUNT_SLUG) throw new CalendarInputError('That name is kept for Calendars on this Mac.');
      if (getCalendarAccount(slug)) throw new CalendarInputError(`You already have a calendar called ${name}.`);
      const url = normalizeCalendarUrl(payload.provider, typeof payload.url === 'string' ? payload.url : '');
      if (!url) throw new CalendarInputError('Enter the server address.');
      const username = text(payload.username, 'the username');
      pw = password(payload.password);
      const access = cleanAccess(payload.access);
      const progress = (step: CalendarProgressStep) => broadcastProgress({ slug, step });

      // Test again here: the sheet's result came from the renderer, and the probe settles the URL.
      progress('saving');
      const probe = await runProbe({ url, username, password: pw });
      if (probe.status === 'rejected') throw new CalendarInputError('The server didn’t accept that username and password.');
      if (probe.status !== 'ok') throw new CalendarInputError(probe.error);

      saved = {
        slug,
        name,
        provider: payload.provider,
        url: probe.url,
        username,
        password: await encryptToBase64(pw),
        calendars: probe.calendars,
        access,
        createdAt: new Date().toISOString(),
        lastCheck: { at: new Date().toISOString(), status: 'ok' },
        lastOkAt: new Date().toISOString(),
      };
      saveCalendarAccount(saved);
      // offer_setup leaves the bridge's list; the reload in applyAccess makes Hermes list it again.
      syncHostToolListing();
      const warning = await applyAccess(saved, {}, pw, progress);
      progress('done');
      persistDebugLog('calendars', 'calendar connected', {
        slug,
        provider: payload.provider,
        agents: Object.entries(access).filter(([, v]) => v !== 'off').map(([k]) => k),
        calendars: probe.calendars.length,
      });
      return { success: true, account: await toCalendarAccountView(saved), ...(warning ? { error: warning } : {}) };
    } catch (error) {
      return connectFailure(saved, errorText(error, [pw]));
    }
  });
}

export function setCalendarAccess(payload: CalendarAccessPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    try {
      const account = getCalendarAccount(String(payload?.slug ?? ''));
      if (!account) throw new CalendarInputError('That calendar isn’t connected any more.');
      const mac = account.provider === 'mac';
      const pw = mac ? '' : await decryptCalendarPassword(account);
      if (!mac && !pw) throw new CalendarInputError(`${APP_NAME} can’t read this calendar’s password any more. Remove it and connect it again.`);
      const previous = account.access;
      const next: StoredCalendarAccount = { ...account, access: cleanAccess(payload.access) };
      saveCalendarAccount(next);
      const progress = (step: CalendarProgressStep) => broadcastProgress({ slug: next.slug, step });
      const warning = await applyAccess(next, previous, pw, progress);
      progress('done');
      return { success: true, account: await toCalendarAccountView(next), ...(warning ? { error: warning } : {}) };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  });
}

export function removeCalendar(payload: CalendarSlugPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    try {
      const account = getCalendarAccount(String(payload?.slug ?? ''));
      if (!account) return { success: true };
      const mac = account.provider === 'mac';
      // Every agent, not only those with access now: an earlier failure may have left one behind.
      for (const agent of listStoredAgents()) {
        if (mac) await revokeMac(agent.slug);
        else await revoke(account.slug, agent.slug);
      }
      deleteCalendarAccount(account.slug);
      if (mac) await syncMacCalendarTokens();
      syncHostToolListing();
      await reloadMcp();
      // caldav-mcp serves CalDAV accounts only.
      if (!mac && !hasCalDavAccounts()) {
        const { compose } = getAssistantStackAccess();
        await compose(['--profile', CALENDAR_COMPOSE_PROFILE, 'rm', '-sf', CALDAV_MCP_SERVICE], { timeout: 120_000 });
        preparing = null;
      }
      persistDebugLog('calendars', 'calendar removed', { slug: account.slug });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorText(error) };
    }
  });
}

type CheckOutcome = { account: StoredCalendarAccount } | { error: string };

/**
 * Run the sign-in test with the stored password and record the result on the account. For the
 * Mac account the test is the Mac's calendar permission.
 */
async function checkAccount(account: StoredCalendarAccount): Promise<CheckOutcome> {
  let probe: CalendarTestResult;
  if (account.provider === 'mac') {
    probe = await checkMacAccess();
  } else {
    const pw = await decryptCalendarPassword(account);
    if (!pw) return { error: `${APP_NAME} can’t read this calendar’s password any more. Remove it and connect it again.` };
    probe = await runProbe({ url: account.url, username: account.username, password: pw });
  }
  // The stack being down says nothing about the sign-in, so it isn't recorded.
  if (probe.status === 'error') return { error: probe.error };
  const current = getCalendarAccount(account.slug);
  if (!current) return { error: 'That calendar isn’t connected any more.' };
  const at = new Date().toISOString();
  const next: StoredCalendarAccount = {
    ...current,
    lastCheck: {
      at,
      status: probe.status,
      ...(probe.status === 'unreachable' ? { error: probe.error } : {}),
    },
    ...(probe.status === 'ok' ? { calendars: probe.calendars, lastOkAt: at } : { lastOkAt: lastWorkedAt(current) ?? undefined }),
  };
  saveCalendarAccount(next);
  if (current.lastCheck?.status !== probe.status) {
    persistDebugLog('calendars', 'sign-in check changed', { slug: account.slug, status: probe.status });
  }
  return { account: next };
}

/** **Test** on the card. */
export async function recheckCalendar(payload: CalendarSlugPayload): Promise<CalendarActionResult> {
  const account = getCalendarAccount(String(payload?.slug ?? ''));
  if (!account) return { success: false, error: 'That calendar isn’t connected any more.' };
  const outcome = await checkAccount(account);
  if ('error' in outcome) return { success: false, error: outcome.error };
  return { success: true, account: await toCalendarAccountView(outcome.account) };
}

/** Every account, one after another. The Calendars tab runs this when it opens. */
export async function recheckAllCalendars(): Promise<CalendarListResult> {
  try {
    if (!(await isAssistantStackReady())) return listCalendars();
    for (const account of listCalendarAccounts()) await checkAccount(account);
    return listCalendars();
  } catch (error) {
    return { ...(await listCalendars()), error: errorText(error) };
  }
}

let dailyTimer: NodeJS.Timeout | null = null;
let dailyRunning = false;

/** Check accounts whose last check is a day old. Skipped while the stack is down. */
export async function runDailyCalendarCheck(now = Date.now()): Promise<void> {
  if (dailyRunning) return;
  dailyRunning = true;
  try {
    const due = listCalendarAccounts().filter((a) => {
      // The Mac account is checked when the card asks, not on a timer.
      if (a.provider === 'mac') return false;
      const at = a.lastCheck ? Date.parse(a.lastCheck.at) : NaN;
      return !Number.isFinite(at) || now - at >= DAILY_CHECK_MS;
    });
    if (!due.length || !(await isAssistantStackReady())) return;
    let changed = false;
    for (const account of due) {
      const outcome = await checkAccount(account);
      if ('account' in outcome) changed = true;
    }
    if (changed) broadcastChanged();
  } catch (error) {
    persistDebugLog('calendars', 'daily sign-in check failed', { error: errorText(error) });
  } finally {
    dailyRunning = false;
  }
}

/** Once a day while the app runs: an hourly tick checks whichever accounts are due. */
export function startCalendarHealthChecks(): void {
  if (dailyTimer) return;
  const first = setTimeout(() => void runDailyCalendarCheck(), FIRST_DAILY_CHECK_MS);
  first.unref?.();
  dailyTimer = setInterval(() => void runDailyCalendarCheck(), DAILY_CHECK_TICK_MS);
  dailyTimer.unref?.();
}

/**
 * **Replace password**: test the new password against the stored address and username, then
 * write it into every profile with access and reload, as a connect does.
 */
export function replaceCalendarPassword(payload: CalendarReplacePasswordPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    let pw = '';
    let saved: StoredCalendarAccount | null = null;
    try {
      const account = getCalendarAccount(String(payload?.slug ?? ''));
      if (!account) throw new CalendarInputError('That calendar isn’t connected any more.');
      if (account.provider === 'mac') throw new CalendarInputError('Calendars on this Mac have no password.');
      pw = password(payload.password);
      const progress = (step: CalendarProgressStep) => broadcastProgress({ slug: account.slug, step });

      progress('saving');
      const probe = await runProbe({ url: account.url, username: account.username, password: pw });
      if (probe.status === 'rejected') throw new CalendarInputError('The server didn’t accept that password.');
      if (probe.status !== 'ok') throw new CalendarInputError(probe.error);

      const at = new Date().toISOString();
      saved = {
        ...account,
        url: probe.url,
        password: await encryptToBase64(pw),
        calendars: probe.calendars,
        lastCheck: { at, status: 'ok' },
        lastOkAt: at,
      };
      saveCalendarAccount(saved);
      const warning = await applyAccess(saved, saved.access, pw, progress);
      progress('done');
      persistDebugLog('calendars', 'calendar password replaced', { slug: saved.slug });
      return { success: true, account: await toCalendarAccountView(saved), ...(warning ? { error: warning } : {}) };
    } catch (error) {
      const message = errorText(error, [pw]);
      if (saved) {
        persistDebugLog('calendars', 'password saved but not given to every agent', { slug: saved.slug, error: message });
        return {
          success: false,
          account: await toCalendarAccountView(saved),
          error: `The new password is saved, but not every agent has it yet. ${message} Use Change access to try again.`,
        };
      }
      return { success: false, error: message };
    }
  });
}
