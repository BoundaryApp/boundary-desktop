import fs from 'node:fs';
import path from 'node:path';
import type {
  CalendarAccess,
  CalendarAccessPayload,
  CalendarActionResult,
  CalendarConnectPayload,
  CalendarListResult,
  CalendarPrepareResult,
  CalendarProgressEvent,
  CalendarProgressStep,
  CalendarReplacePasswordPayload,
  CalendarSlugPayload,
  CalendarTestPayload,
  CalendarTestResult,
} from '../../../../shared/types/calendars';
import { persistDebugLog } from '../../../persistDebugLog';
import { getAssistantStackAccess, isAssistantStackReady } from '../AssistantStackService';
import { buildHermesConfigSetExec } from '../hermesConfigSetExec';
import { redactSecrets } from '../../secrets/redact';
import { broadcast } from '../../windows';
import { encryptToBase64, isOsEncryptionAvailable } from '../../secrets/osEncryption';
import { hermesProfileEnvPath } from '../../hostBridge/hermesProvision';
import { removeEnvLines, upsertEnvLines } from '../stackEnv';
import { syncHostToolListing } from '../../hostBridge/hostBridgeService';
import { resolveProfileForAgent } from '../hermes/hermesAgents';
import { listStoredAgents } from '../hermes/hermesAgentStore';
import { getHermesGatewaySession } from '../hermes/hermesGatewaySession';
import { JsonRpcGatewayError } from '../hermes/vendor/json-rpc-channel';
import { gatewayErrorText } from '../hermes/gatewayErrorText';
import { caldavProbeArgs, caldavProbeInput, parseCaldavProbeOutput } from './caldavProbe';
import {
  CALDAV_MCP_SERVICE,
  CALENDAR_COMPOSE_PROFILE,
  calendarMcpEntry,
  calendarPasswordEnvKey,
  calendarPasswordProblem,
  calendarServerName,
  calendarSlug,
  expectedToolCount,
  isCalendarProvider,
  normalizeCalendarUrl,
} from './calendarModel';
import {
  decryptCalendarPassword,
  deleteCalendarAccount,
  getCalendarAccount,
  hasCalendarAccounts,
  listCalendarAccounts,
  saveCalendarAccount,
  lastWorkedAt,
  toCalendarAccountView,
  type StoredCalendarAccount,
} from './calendarStore';

/**
 * Settings → Calendars (docs/calendar-ux-study/spec.md, Phases 1 and 2). Boundary writes each calendar
 * into the profiles of the agents that may use it, the way it provisions the host bridge: the
 * password into the profile's `.env`, the `calendar-<slug>` entry with `hermes config set`. Hermes
 * connects new sessions to it on its own, and `reload.mcp` brings open chats and changed entries up
 * to date, so nothing restarts.
 *
 * Payloads carry a password. Never log a payload, and scrub the password from any error text.
 */

/** `change` is safe to offer because every entry is `trust: untrusted` (spec decision 6). */
const OFFERED_ACCESS: ReadonlySet<CalendarAccess> = new Set(['off', 'read', 'change']);
const MAX_TEXT = 512;
/** caldav-mcp is built from source on first start (about 2.5 min on an M-series Mac). */
const PREPARE_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
const CONNECT_CHECK_MS = 30_000;
/** The background sign-in check (spec Phase 2, item 3). */
const DAILY_CHECK_MS = 24 * 60 * 60_000;
const DAILY_CHECK_TICK_MS = 60 * 60_000;
const FIRST_DAILY_CHECK_MS = 2 * 60_000;

class CalendarInputError extends Error {}

function errorText(err: unknown, secrets: readonly string[] = []): string {
  if (err instanceof CalendarInputError) return err.message;
  return gatewayErrorText(err, secrets, {
    methodMissing: 'This version of Hermes can’t manage MCP servers. Update the agent stack and try again.',
    fallback: 'Something went wrong.',
    maxLength: 400,
  });
}

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

/** Access for known agents only, limited to the offered levels; everyone else is off. */
function cleanAccess(value: unknown): Record<string, CalendarAccess> {
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

function broadcastProgress(event: CalendarProgressEvent): void {
  broadcast('calendars:progress', event);
}

/** Tell an open Calendars tab that a background check changed a card. */
function broadcastChanged(): void {
  broadcast('calendars:changed');
}

/** One change at a time: two writes to the same profile files must not interleave. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch((): void => undefined);
  return next;
}

// ─── caldav-mcp ───────────────────────────────────────────────────────────────

let preparing: Promise<CalendarPrepareResult> | null = null;

/**
 * Start caldav-mcp (building it the first time). The connect sheet calls this when it opens, so
 * the build overlaps with choosing a provider and fetching an app password.
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

// ─── Writing into Hermes ──────────────────────────────────────────────────────

function profileFor(agentSlug: string): string {
  return resolveProfileForAgent(agentSlug) ?? '';
}

function profileParams(profile: string): Record<string, unknown> {
  return profile ? { profile } : {};
}

async function editProfileEnv(dataRoot: string, profile: string, edit: (current: string) => string): Promise<boolean> {
  const envPath = hermesProfileEnvPath(dataRoot, profile);
  if (!fs.existsSync(path.dirname(envPath))) return false;
  let current = '';
  try {
    current = await fs.promises.readFile(envPath, 'utf8');
  } catch {
    /* new file */
  }
  const next = edit(current);
  if (next !== current) await fs.promises.writeFile(envPath, next, { encoding: 'utf8', mode: 0o600 });
  return true;
}

/** Give one agent the calendar: the password in its `.env`, then the entry. */
async function grant(account: StoredCalendarAccount, agentSlug: string, access: CalendarAccess, pw: string): Promise<void> {
  const { compose, dataRoot } = getAssistantStackAccess();
  const profile = profileFor(agentSlug);
  const written = await editProfileEnv(dataRoot, profile, (current) =>
    upsertEnvLines(current, { [calendarPasswordEnvKey(account.slug)]: pw })
  );
  if (!written) return; // The agent's profile folder is gone.
  const entry = calendarMcpEntry({ slug: account.slug, url: account.url, username: account.username, access });
  // The entry names the password's env key, not the value; it still goes through the environment
  // so the username and URL stay off the command line.
  const { args, env } = buildHermesConfigSetExec(
    profile,
    `mcp_servers.${calendarServerName(account.slug)}`,
    JSON.stringify(entry),
    { secret: true }
  );
  await compose(args, { timeout: 60_000, env });
}

/** Take the calendar away from one agent: the entry, then the password. */
async function revoke(slug: string, agentSlug: string): Promise<void> {
  const { dataRoot } = getAssistantStackAccess();
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
  await editProfileEnv(dataRoot, profile, (current) => removeEnvLines(current, [calendarPasswordEnvKey(slug)]));
}

async function reloadMcp(): Promise<void> {
  await getHermesGatewaySession().requestMcp('reload.mcp', { confirm: true });
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
  const want = expectedToolCount(access);
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

/** Bring every agent's profile in line with `next`, then reload once. */
async function applyAccess(
  account: StoredCalendarAccount,
  previous: Record<string, CalendarAccess>,
  pw: string,
  progress: (step: CalendarProgressStep) => void
): Promise<string | null> {
  progress('access');
  const agents = new Set([...Object.keys(previous), ...Object.keys(account.access)]);
  for (const agentSlug of agents) {
    const level = account.access[agentSlug] ?? 'off';
    if (level === 'off') {
      if ((previous[agentSlug] ?? 'off') !== 'off') await revoke(account.slug, agentSlug);
    } else {
      await grant(account, agentSlug, level, pw);
    }
  }
  await reloadMcp();
  progress('checking');
  return checkHermesSees(account);
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
        throw new CalendarInputError('Boundary can’t store passwords on this Mac because the keychain isn’t available.');
      }
      if (!isCalendarProvider(payload?.provider)) throw new CalendarInputError('Choose a provider.');
      const name = text(payload.name, 'a name');
      const slug = calendarSlug(name);
      if (!slug) throw new CalendarInputError('Give it a name with at least one letter or number.');
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
      const message = errorText(error, [pw]);
      if (saved) {
        persistDebugLog('calendars', 'calendar saved but not given to every agent', { slug: saved.slug, error: message });
        return {
          success: false,
          account: await toCalendarAccountView(saved),
          error: `${saved.name} is saved, but not every agent has it yet. ${message} Use Change access to try again.`,
        };
      }
      return { success: false, error: message };
    }
  });
}

export function setCalendarAccess(payload: CalendarAccessPayload): Promise<CalendarActionResult> {
  return serial(async () => {
    try {
      const account = getCalendarAccount(String(payload?.slug ?? ''));
      if (!account) throw new CalendarInputError('That calendar isn’t connected any more.');
      const pw = await decryptCalendarPassword(account);
      if (!pw) throw new CalendarInputError('Boundary can’t read this calendar’s password any more. Remove it and connect it again.');
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
      // Every agent, not only those with access now: an earlier failure may have left one behind.
      for (const agent of listStoredAgents()) await revoke(account.slug, agent.slug);
      deleteCalendarAccount(account.slug);
      syncHostToolListing();
      await reloadMcp();
      if (!hasCalendarAccounts()) {
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

/** Run the sign-in test with the stored password and record the result on the account. */
async function checkAccount(account: StoredCalendarAccount): Promise<CheckOutcome> {
  const pw = await decryptCalendarPassword(account);
  if (!pw) return { error: 'Boundary can’t read this calendar’s password any more. Remove it and connect it again.' };
  const probe = await runProbe({ url: account.url, username: account.username, password: pw });
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
