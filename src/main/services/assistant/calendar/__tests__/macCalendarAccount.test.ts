import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MacCalendarSummary } from '../../../../../shared/types/calendars';

const h = vi.hoisted(() => ({
  dataRoot: '',
  compose: vi.fn(),
  requestMcp: vi.fn(),
  helperRequest: vi.fn(),
  log: vi.fn(),
  helperState: 'running' as string,
  helperRestart: vi.fn(),
  access: 'granted' as string,
  calendars: [] as unknown[],
  storeData: {} as Record<string, unknown>,
  /** `tokens:<agents>` when the token map is pushed, `reload` for reload.mcp, `listing:<n>` for the bridge listing. */
  events: [] as string[],
  tokenMaps: [] as Array<Record<string, string>>,
  /** Set to make ensureHostBridgeStarted refuse, as it does while computer access is stopped. */
  bridgeRefuses: false,
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): Electron.BrowserWindow[] => [] },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s: string) => Buffer.from(`enc:${s}`),
    decryptStringAsync: async (b: Buffer) => ({ result: b.toString().slice(4), shouldReEncrypt: false }),
  },
}));

vi.mock('electron-store', () => ({
  default: class {
    constructor(opts: { defaults: Record<string, unknown> }) {
      Object.assign(h.storeData, structuredClone(opts.defaults));
    }
    get(key: string) {
      return structuredClone(h.storeData[key]);
    }
    set(key: string, value: unknown) {
      h.storeData[key] = structuredClone(value);
    }
  },
}));

vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: h.log }));

vi.mock('../../AssistantStackService', () => ({
  isAssistantStackReady: async () => true,
  getAssistantStackAccess: () => ({ compose: h.compose, composeWithInput: vi.fn(), dataRoot: h.dataRoot }),
}));

vi.mock('../../hermes/hermesAgentStore', () => ({
  listStoredAgents: () => [
    { slug: 'assistant', displayName: 'Hermes', builtIn: true },
    { slug: 'researcher', displayName: 'Researcher', builtIn: false },
    { slug: 'writer', displayName: 'Writer', builtIn: false },
  ],
}));

vi.mock('../../hermes/hermesAgents', () => ({
  resolveProfileForAgent: (slug: string) => (slug === 'assistant' ? null : slug),
}));

vi.mock('../../../hostBridge/hostBridgeService', () => ({
  syncHostToolListing: () => h.events.push(`listing:${(h.storeData.accounts as unknown[]).length}`),
  setCalendarTokens: (tokens: Record<string, string>) => {
    h.tokenMaps.push(tokens);
    h.events.push(`tokens:${Object.values(tokens).sort().join(',')}`);
  },
  ensureHostBridgeStarted: async () => {
    if (h.bridgeRefuses) throw new Error('Computer access is stopped. Turn it back on in Settings → Computer access.');
    return { mcpPort: 47001, browserPort: 47002, mcpToken: 'm', browserToken: 'b' };
  },
}));

vi.mock('../../hermes/hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({ requestMcp: h.requestMcp }),
}));

vi.mock('../macCalendarHelper', () => ({
  getMacCalendarHelper: () => ({ state: () => h.helperState, request: h.helperRequest, restart: h.helperRestart }),
}));

import {
  connectMacCalendars,
  macCalendarStatus,
  requestMacCalendarAccess,
  restartMacCalendarHelper,
  setMacCalendars,
  syncMacCalendarTokens,
} from '../macCalendarAccount';
import { connectCalendar, recheckCalendar, removeCalendar, runDailyCalendarCheck, setCalendarAccess } from '../calendarService';
import { MAC_TOKEN_ENV, defaultAllowedCalendarIds } from '../calendarModel';
import { hasCalDavAccounts, type StoredCalendarAccount } from '../calendarStore';
import { MAC_CHANGE_TOOLS, MAC_READ_TOOLS } from '../macCalendarTools';
import { HERMES_CONFIG_SECRET_ENV } from '../../hermesConfigSetExec';

/** Synthetic calendars, one of each kind the choose step treats differently. */
const CALENDARS: MacCalendarSummary[] = [
  { id: 'cal-work', title: 'Synthetic Work', color: '#336699', source: 'iCloud', kind: 'icloud', writable: true },
  { id: 'cal-home', title: 'Synthetic Home', color: '#993366', source: 'Google', kind: 'google', writable: true },
  { id: 'cal-bday', title: 'Synthetic Birthdays', color: '#999999', source: 'Other', kind: 'birthdays', writable: false },
  { id: 'cal-subs', title: 'Synthetic Holidays', color: '#669933', source: 'Subscribed', kind: 'subscribed', writable: false },
];
const TITLES = CALENDARS.map((c) => c.title);

function envOf(profile: string): string {
  const file =
    profile === ''
      ? path.join(h.dataRoot, 'hermes', '.env')
      : path.join(h.dataRoot, 'hermes', 'profiles', profile, '.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function tokenIn(profile: string): string | undefined {
  return new RegExp(`^${MAC_TOKEN_ENV}=([0-9a-f]+)$`, 'm').exec(envOf(profile))?.[1];
}

/** The `hermes config set` calls: [args, entry JSON from the environment]. */
function configSets(): Array<{ args: string[]; entry: Record<string, unknown> }> {
  return h.compose.mock.calls
    .filter(([args]) => (args as string[]).includes('config'))
    .map(([args, opts]) => ({
      args: args as string[],
      entry: JSON.parse((opts as { env: NodeJS.ProcessEnv }).env[HERMES_CONFIG_SECRET_ENV] as string),
    }));
}

function storedMac(): StoredCalendarAccount | undefined {
  return (h.storeData.accounts as StoredCalendarAccount[]).find((a) => a.slug === 'mac');
}

const connectMac = (access: Record<string, 'off' | 'read' | 'change'>, allowedCalendarIds = ['cal-work', 'cal-home']) =>
  connectMacCalendars({ allowedCalendarIds, access });

beforeEach(() => {
  h.dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-calendar-'));
  for (const profile of ['researcher', 'writer']) {
    fs.mkdirSync(path.join(h.dataRoot, 'hermes', 'profiles', profile), { recursive: true });
  }
  fs.writeFileSync(path.join(h.dataRoot, 'hermes', '.env'), 'OPENAI_API_KEY=x\n');
  h.storeData.accounts = [];
  h.helperState = 'running';
  h.access = 'granted';
  h.calendars = structuredClone(CALENDARS);
  h.events = [];
  h.tokenMaps = [];
  h.bridgeRefuses = false;
  h.log.mockReset();
  h.compose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  h.helperRequest.mockReset().mockImplementation(async (op: string) => {
    if (op === 'status') return { access: h.access };
    if (op === 'requestAccess') {
      h.access = 'granted';
      return { access: h.access };
    }
    if (op === 'listCalendars') return structuredClone(h.calendars);
    throw new Error(`unexpected op ${op}`);
  });
  h.requestMcp.mockReset().mockImplementation(async (method: string) => {
    if (method === 'reload.mcp') h.events.push('reload');
    return method === 'mcp.servers.status'
      ? { servers: [{ name: 'calendar-mac', connected: true, status: 'connected', tools: 12 }] }
      : {};
  });
});

afterEach(() => {
  fs.rmSync(h.dataRoot, { recursive: true, force: true });
});

describe('the choose step', () => {
  it('ticks every calendar except birthdays and subscribed by default', () => {
    expect(defaultAllowedCalendarIds(CALENDARS)).toEqual(['cal-work', 'cal-home']);
  });
});

describe('macCalendarStatus', () => {
  it('lists the calendars only once access is granted', async () => {
    expect(await macCalendarStatus()).toEqual({ access: 'granted', calendars: CALENDARS });
    h.access = 'notDetermined';
    expect(await macCalendarStatus()).toEqual({ access: 'notDetermined', calendars: [] });
  });

  it('reports a missing or stopped helper without asking it', async () => {
    for (const state of ['missing', 'stopped']) {
      h.helperState = state;
      expect(await macCalendarStatus()).toEqual({ access: state, calendars: [] });
    }
    expect(h.helperRequest).not.toHaveBeenCalled();
  });

  it('restarts a stopped helper and answers with its new status', async () => {
    h.helperState = 'stopped';
    h.helperRestart.mockReset().mockImplementation(() => {
      h.helperState = 'running';
    });
    expect(await restartMacCalendarHelper()).toEqual({ access: 'granted', calendars: CALENDARS });
    expect(h.helperRestart).toHaveBeenCalledTimes(1);
    // The log line holds the state only.
    const line = h.log.mock.calls.find((c) => c[1] === 'mac calendar helper restarted');
    expect(line?.[2]).toEqual({ state: 'running' });
  });

  it('asks for access and lists the calendars when it is given', async () => {
    h.access = 'notDetermined';
    expect(await requestMacCalendarAccess()).toEqual({ access: 'granted', calendars: CALENDARS });
  });

  it('drops a ticked calendar that no longer exists and names it in the result', async () => {
    await connectMac({ assistant: 'read' });
    h.calendars = CALENDARS.filter((c) => c.id !== 'cal-home');
    const status = await macCalendarStatus();
    expect(status.dropped).toEqual(['Synthetic Home']);
    expect(storedMac()?.allowedCalendarIds).toEqual(['cal-work']);
    // Dropped once: the next status names nothing.
    expect((await macCalendarStatus()).dropped).toBeUndefined();
  });
});

describe('connectMacCalendars', () => {
  it('refuses an empty allowed list', async () => {
    expect(await connectMac({ assistant: 'read' }, [])).toEqual({ success: false, error: 'Choose at least one calendar.' });
    // Ids the Mac doesn't have count as none.
    expect(await connectMac({ assistant: 'read' }, ['cal-gone'])).toEqual({ success: false, error: 'Choose at least one calendar.' });
    expect(storedMac()).toBeUndefined();
    expect(h.compose).not.toHaveBeenCalled();
  });

  it('gives each granted agent its own token and entry, and none to agents set to off', async () => {
    const result = await connectMac({ assistant: 'read', researcher: 'change', writer: 'off' });
    expect(result).toMatchObject({
      success: true,
      account: { slug: 'mac', name: 'This Mac', provider: 'mac', allowedCalendarIds: ['cal-work', 'cal-home'], passwordTail: '' },
    });
    expect(result.error).toBeUndefined();

    const assistantToken = tokenIn('');
    const researcherToken = tokenIn('researcher');
    expect(assistantToken).toMatch(/^[0-9a-f]{64}$/);
    expect(researcherToken).toMatch(/^[0-9a-f]{64}$/);
    expect(assistantToken).not.toBe(researcherToken);
    expect(envOf('')).toContain('OPENAI_API_KEY=x');
    expect(envOf('writer')).not.toContain(MAC_TOKEN_ENV);

    const sets = configSets();
    expect(sets).toHaveLength(2);
    const byProfile = Object.fromEntries(sets.map((s) => [s.args.includes('-p') ? s.args[s.args.indexOf('-p') + 1] : 'default', s]));
    expect(byProfile.default.args).toContain('mcp_servers.calendar-mac');
    expect(byProfile.default.entry).toEqual({
      url: 'http://host.docker.internal:47001/calendar',
      timeout: 60,
      connect_timeout: 60,
      keepalive_interval: 15,
      parked_retry_interval: 15,
      trust: 'untrusted',
      headers: { Authorization: `Bearer \${${MAC_TOKEN_ENV}}` },
      tools: { include: [...MAC_READ_TOOLS] },
    });
    expect(byProfile.researcher.entry).toMatchObject({ tools: { include: [...MAC_READ_TOOLS, ...MAC_CHANGE_TOOLS] } });
    expect(byProfile.writer).toBeUndefined();
    for (const s of sets) expect(JSON.stringify(s.entry)).not.toMatch(/[0-9a-f]{64}/);

    expect(h.tokenMaps.at(-1)).toEqual({ [assistantToken!]: 'assistant', [researcherToken!]: 'researcher' });
    // Kept encrypted, one per granted agent.
    const stored = storedMac()?.agentTokens ?? {};
    expect(Object.keys(stored).sort()).toEqual(['assistant', 'researcher']);
    expect(Object.values(stored)).not.toContain(assistantToken);
    // The bridge has the tokens before Hermes reconnects.
    expect(h.events).toEqual(['listing:1', 'tokens:assistant,researcher', 'reload']);
  });

  it('refuses a second Mac account', async () => {
    await connectMac({ assistant: 'read' });
    expect(await connectMac({ assistant: 'read' })).toEqual({
      success: false,
      error: 'Calendars on this Mac are already connected.',
    });
  });

  it('refuses while the Mac hasn’t given access', async () => {
    h.access = 'denied';
    expect(await connectMac({ assistant: 'read' })).toMatchObject({ success: false });
    expect(storedMac()).toBeUndefined();
  });
});

describe('access changes and removal', () => {
  it('removes the entry, the .env key and the token when access goes to off', async () => {
    await connectMac({ assistant: 'read', researcher: 'read' });
    const assistantToken = tokenIn('');
    h.events = [];

    const result = await setCalendarAccess({ slug: 'mac', access: { assistant: 'read', researcher: 'off' } });
    expect(result.success).toBe(true);
    expect(h.requestMcp).toHaveBeenCalledWith('mcp.servers.remove', { profile: 'researcher', name: 'calendar-mac' });
    expect(envOf('researcher')).not.toContain(MAC_TOKEN_ENV);
    expect(Object.keys(storedMac()?.agentTokens ?? {})).toEqual(['assistant']);
    // The agent that keeps access keeps its token.
    expect(tokenIn('')).toBe(assistantToken);
    expect(h.tokenMaps.at(-1)).toEqual({ [assistantToken!]: 'assistant' });
    expect(h.events).toEqual(['tokens:assistant', 'reload']);
  });

  it('saves a new allowed list without touching Hermes', async () => {
    await connectMac({ assistant: 'read' });
    h.compose.mockClear();
    h.requestMcp.mockClear();
    const result = await setMacCalendars({ allowedCalendarIds: ['cal-bday'] });
    expect(result).toMatchObject({ success: true, account: { allowedCalendarIds: ['cal-bday'] } });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.requestMcp).not.toHaveBeenCalled();
    expect(await setMacCalendars({ allowedCalendarIds: [] })).toEqual({ success: false, error: 'Choose at least one calendar.' });
    expect(storedMac()?.allowedCalendarIds).toEqual(['cal-bday']);
  });

  it('removing the account clears every agent and the bridge’s tokens, and leaves caldav-mcp alone', async () => {
    await connectMac({ assistant: 'read', researcher: 'read' });
    const result = await removeCalendar({ slug: 'mac' });
    expect(result.success).toBe(true);
    expect(envOf('')).not.toContain(MAC_TOKEN_ENV);
    expect(envOf('researcher')).not.toContain(MAC_TOKEN_ENV);
    expect(storedMac()).toBeUndefined();
    expect(h.tokenMaps.at(-1)).toEqual({});
    expect(h.compose.mock.calls.some(([a]) => (a as string[]).includes('caldav-mcp'))).toBe(false);
  });

  it('pushes the stored tokens to the bridge at start', async () => {
    await connectMac({ assistant: 'read' });
    h.tokenMaps = [];
    await syncMacCalendarTokens();
    expect(h.tokenMaps).toEqual([{ [tokenIn('')!]: 'assistant' }]);
  });

  it('the daily CalDAV check skips the Mac account', async () => {
    await connectMac({ assistant: 'read' });
    const before = JSON.stringify(storedMac());
    h.helperRequest.mockClear();
    await runDailyCalendarCheck(Date.now() + 25 * 60 * 60_000);
    expect(h.helperRequest).not.toHaveBeenCalled();
    expect(JSON.stringify(storedMac())).toBe(before);
  });

  it('Test on the card records access turned off in System Settings', async () => {
    await connectMac({ assistant: 'read' });
    h.access = 'denied';
    const result = await recheckCalendar({ slug: 'mac' });
    expect(result.account?.lastCheck?.status).toBe('rejected');
  });
});

describe('partial failures', () => {
  it('gives the bridge the tokens agents hold when a later grant fails, and skips the reload', async () => {
    h.compose.mockImplementation(async (args: string[]) => {
      if (args.includes('config') && args.includes('researcher')) throw new Error('config set failed');
      return { stdout: '', stderr: '' };
    });
    const result = await connectMac({ assistant: 'read', researcher: 'read' });
    expect(result.success).toBe(false);
    expect(h.tokenMaps.at(-1)).toMatchObject({ [tokenIn('')!]: 'assistant' });
    expect(h.events).not.toContain('reload');
  });

  it('stores no token when the bridge refuses the grant', async () => {
    h.bridgeRefuses = true;
    const result = await connectMac({ assistant: 'read' });
    expect(result.success).toBe(false);
    expect(storedMac()?.agentTokens).toEqual({});
    expect(envOf('')).not.toContain(MAC_TOKEN_ENV);
  });
});

describe('the CalDAV connect', () => {
  it('refuses a CalDAV account whose name slugifies to mac', async () => {
    for (const name of ['Mac', ' MAC! ']) {
      const result = await connectCalendar({
        name,
        provider: 'icloud',
        url: '',
        username: 'sam@example.com',
        password: 'abcd-efgh-ijkl-mnop',
        access: { assistant: 'read' },
      });
      expect(result).toEqual({ success: false, error: 'That name is kept for Calendars on this Mac.' });
    }
  });
});

describe('CalDAV accounts beside the Mac account', () => {
  const caldav = (password: string): StoredCalendarAccount => ({
    slug: 'personal',
    name: 'Personal',
    provider: 'icloud',
    url: 'https://caldav.icloud.com/',
    username: 'sam@example.com',
    password,
    calendars: [],
    access: { assistant: 'read' },
    createdAt: '2026-11-01T00:00:00.000Z',
    lastCheck: null,
  });

  it('counts only CalDAV accounts as needing caldav-mcp', async () => {
    await connectMac({ assistant: 'read' });
    expect(hasCalDavAccounts()).toBe(false);
    h.storeData.accounts = [...(h.storeData.accounts as unknown[]), caldav(Buffer.from('enc:pw').toString('base64'))];
    expect(hasCalDavAccounts()).toBe(true);
  });

  it('still refuses an access change when a CalDAV password decrypts empty', async () => {
    h.storeData.accounts = [caldav(Buffer.from('enc:').toString('base64'))];
    const result = await setCalendarAccess({ slug: 'personal', access: { assistant: 'read' } });
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/can’t read this calendar’s password/) });
    expect(h.compose).not.toHaveBeenCalled();
  });
});

describe('logging', () => {
  it('logs agent slugs and counts but no calendar titles', async () => {
    await connectMac({ assistant: 'read', researcher: 'change' });
    h.calendars = CALENDARS.filter((c) => c.id !== 'cal-home');
    await macCalendarStatus();
    await setMacCalendars({ allowedCalendarIds: ['cal-work'] });
    await setCalendarAccess({ slug: 'mac', access: { assistant: 'read' } });
    await removeCalendar({ slug: 'mac' });

    const logged = JSON.stringify(h.log.mock.calls);
    expect(logged).toContain('researcher');
    for (const title of TITLES) expect(logged).not.toContain(title);
    expect(logged).not.toMatch(/[0-9a-f]{64}/);
  });
});
