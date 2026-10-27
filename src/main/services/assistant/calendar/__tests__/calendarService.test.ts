import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dataRoot: '',
  compose: vi.fn(),
  composeWithInput: vi.fn(),
  requestMcp: vi.fn(),
  storeData: {} as Record<string, unknown>,
  /** `listing:<calendars stored>` when the bridge listing is synced, `reload` for reload.mcp. */
  events: [] as string[],
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
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

vi.mock('../../../../persistDebugLog', () => ({ persistDebugLog: vi.fn() }));

vi.mock('../../AssistantStackService', () => ({
  isAssistantStackReady: async () => true,
  getAssistantStackAccess: () => ({
    compose: h.compose,
    composeWithInput: h.composeWithInput,
    dataRoot: h.dataRoot,
  }),
}));

vi.mock('../../hermes/hermesAgentStore', () => ({
  listStoredAgents: () => [
    { slug: 'assistant', displayName: 'Hermes', builtIn: true },
    { slug: 'researcher', displayName: 'Researcher', builtIn: false },
  ],
}));

vi.mock('../../hermes/hermesAgents', () => ({
  resolveProfileForAgent: (slug: string) => (slug === 'assistant' ? null : slug),
}));

vi.mock('../../../hostBridge/hostBridgeService', () => ({
  syncHostToolListing: () => h.events.push(`listing:${(h.storeData.accounts as unknown[]).length}`),
}));

vi.mock('../../hermes/hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({ requestMcp: h.requestMcp }),
}));

import {
  connectCalendar,
  recheckAllCalendars,
  recheckCalendar,
  removeCalendar,
  replaceCalendarPassword,
  runDailyCalendarCheck,
  setCalendarAccess,
  testCalendarSignIn,
} from '../calendarService';
import { CALDAV_CHANGE_TOOLS, CALDAV_READ_TOOLS } from '../calendarModel';
import { HERMES_CONFIG_SECRET_ENV } from '../../hermesConfigSetExec';

const PW = 'abcd-efgh-ijkl-mnop';
const OK_PROBE =
  'CALDAV_PROBE {"status": "ok", "url": "https://caldav.icloud.com/", "calendars": [{"name": "Home", "url": "https://caldav.icloud.com/1/home/"}]}';

function envOf(profile: string): string {
  const file =
    profile === ''
      ? path.join(h.dataRoot, 'hermes', '.env')
      : path.join(h.dataRoot, 'hermes', 'profiles', profile, '.env');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** The `hermes config set` calls: [profile flag, key, entry JSON from the environment]. */
function configSets(): Array<{ args: string[]; entry: Record<string, unknown> }> {
  return h.compose.mock.calls
    .filter(([args]) => (args as string[]).includes('config'))
    .map(([args, opts]) => ({
      args: args as string[],
      entry: JSON.parse((opts as { env: NodeJS.ProcessEnv }).env[HERMES_CONFIG_SECRET_ENV] as string),
    }));
}

function connect(access: Record<string, 'off' | 'read' | 'change'>) {
  return connectCalendar({
    name: 'Personal',
    provider: 'icloud',
    url: '',
    username: 'sam@example.com',
    password: PW,
    access,
  });
}

beforeEach(() => {
  h.dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-svc-'));
  fs.mkdirSync(path.join(h.dataRoot, 'hermes', 'profiles', 'researcher'), { recursive: true });
  fs.writeFileSync(path.join(h.dataRoot, 'hermes', '.env'), 'OPENAI_API_KEY=x\n');
  h.storeData.accounts = [];
  h.compose.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  h.composeWithInput.mockReset().mockResolvedValue({ stdout: OK_PROBE, stderr: '', code: 0 });
  h.events = [];
  h.requestMcp.mockReset().mockImplementation(async (method: string) => {
    if (method === 'reload.mcp') h.events.push('reload');
    return method === 'mcp.servers.status'
      ? { servers: [{ name: 'calendar-personal', connected: true, status: 'connected', tools: 18 }] }
      : {};
  });
});

afterEach(() => {
  fs.rmSync(h.dataRoot, { recursive: true, force: true });
});

describe('testCalendarSignIn', () => {
  it('starts the calendar service and sends the password only on stdin', async () => {
    const result = await testCalendarSignIn({ provider: 'icloud', url: '', username: 'sam@example.com', password: PW });
    expect(result.status).toBe('ok');
    const [args, input] = h.composeWithInput.mock.calls[0] as [string[], string];
    expect(args.join(' ')).not.toContain(PW);
    expect(input).toContain(PW);
    expect(h.compose.mock.calls.some(([a]) => (a as string[]).join(' ') === '--profile calendar up -d caldav-mcp')).toBe(true);
  });

  it('refuses a password Hermes would change before running anything', async () => {
    const result = await testCalendarSignIn({ provider: 'icloud', url: '', username: 'sam', password: 'pa$$word' });
    expect(result).toMatchObject({ status: 'error' });
    expect(h.composeWithInput).not.toHaveBeenCalled();
  });
});

describe('connectCalendar', () => {
  it('gives only the agents with access the entry and the password', async () => {
    const result = await connect({ assistant: 'read', researcher: 'off' });
    expect(result).toMatchObject({ success: true, account: { slug: 'personal', passwordTail: 'mnop' } });
    expect(result.error).toBeUndefined();

    expect(envOf('')).toContain(`BOUNDARY_CALENDAR_PERSONAL_PASSWORD=${PW}`);
    expect(envOf('')).toContain('OPENAI_API_KEY=x');
    expect(envOf('researcher')).not.toContain('BOUNDARY_CALENDAR');

    const sets = configSets();
    expect(sets).toHaveLength(1);
    expect(sets[0].args).toContain('mcp_servers.calendar-personal');
    expect(sets[0].args).not.toContain('-p');
    expect(sets[0].entry).toMatchObject({ trust: 'untrusted', headers: { 'X-Caldav-Url': 'https://caldav.icloud.com/' } });
    expect(JSON.stringify(sets[0].entry)).not.toContain(PW);
    expect(h.requestMcp).toHaveBeenCalledWith('reload.mcp', { confirm: true });
  });

  it('drops offer_setup from the bridge listing before the reload that re-lists it (3.2)', async () => {
    await connect({ assistant: 'read' });
    expect(h.events).toEqual(['listing:1', 'reload']);
  });

  it('leaves the listing alone when the sign-in is rejected', async () => {
    h.composeWithInput.mockResolvedValue({ stdout: 'CALDAV_PROBE {"status": "rejected"}', stderr: '', code: 0 });
    await connect({ assistant: 'read' });
    expect(h.events).toEqual([]);
  });

  it('gives Read only the query tools and Read and change all 14, every entry untrusted', async () => {
    await connect({ assistant: 'change', researcher: 'read' });
    const sets = configSets();
    expect(sets).toHaveLength(2);
    const byProfile = Object.fromEntries(sets.map((s) => [s.args.includes('-p') ? 'researcher' : 'default', s.entry]));
    expect(byProfile.default).toMatchObject({ trust: 'untrusted', tools: { include: [...CALDAV_READ_TOOLS, ...CALDAV_CHANGE_TOOLS] } });
    expect(byProfile.researcher).toMatchObject({ trust: 'untrusted', tools: { include: [...CALDAV_READ_TOOLS] } });
    expect(envOf('researcher')).toContain(`BOUNDARY_CALENDAR_PERSONAL_PASSWORD=${PW}`);
  });

  it('ignores access levels it doesn’t know', async () => {
    await connect({ assistant: 'admin' as never });
    expect(configSets()).toHaveLength(0);
    expect(envOf('')).not.toContain('BOUNDARY_CALENDAR');
  });

  it('records when the sign-in last worked', async () => {
    const result = await connect({ assistant: 'read' });
    expect(result.account?.lastOkAt).toBeTruthy();
  });

  it('saves nothing when the server rejects the sign-in', async () => {
    h.composeWithInput.mockResolvedValue({ stdout: 'CALDAV_PROBE {"status": "rejected"}', stderr: '', code: 0 });
    const result = await connect({ assistant: 'read' });
    expect(result.success).toBe(false);
    expect(result.account).toBeUndefined();
    expect(envOf('')).not.toContain('BOUNDARY_CALENDAR');
  });

  it('refuses a second calendar with the same name', async () => {
    await connect({ assistant: 'read' });
    const again = await connect({ assistant: 'read' });
    expect(again).toMatchObject({ success: false, error: 'You already have a calendar called Personal.' });
  });

  it('says so when Hermes hasn’t connected yet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    h.requestMcp.mockImplementation(async (method: string) =>
      method === 'mcp.servers.status' ? { servers: [{ name: 'calendar-personal', connected: false, status: 'failed', tools: 0 }] } : {}
    );
    let settled = false;
    const pending = connect({ assistant: 'read' }).finally(() => {
      settled = true;
    });
    // The service reads and writes real files before it starts polling, and under load that
    // takes any number of event-loop turns. Move the clock only while the service waits on a
    // timer, so the fake clock can't run past the poll deadline before polling starts.
    try {
      while (!settled) {
        if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
        else await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      vi.useRealTimers();
    }
    const result = await pending;
    expect(result.success).toBe(true);
    expect(result.error).toMatch(/couldn’t connect to Personal/);
  });
});

describe('setCalendarAccess', () => {
  it('turning an agent off removes its entry and its password', async () => {
    await connect({ assistant: 'read', researcher: 'read' });
    expect(envOf('researcher')).toContain('BOUNDARY_CALENDAR_PERSONAL_PASSWORD');

    const result = await setCalendarAccess({ slug: 'personal', access: { assistant: 'read', researcher: 'off' } });
    expect(result.success).toBe(true);
    expect(h.requestMcp).toHaveBeenCalledWith('mcp.servers.remove', { profile: 'researcher', name: 'calendar-personal' });
    expect(envOf('researcher')).not.toContain('BOUNDARY_CALENDAR');
    expect(envOf('')).toContain('BOUNDARY_CALENDAR_PERSONAL_PASSWORD');
  });
});

describe('removeCalendar', () => {
  it('clears every profile and stops the calendar service with the last account', async () => {
    await connect({ assistant: 'read' });
    h.requestMcp.mockImplementation(async (method: string, params: { profile?: string }) => {
      if (method === 'mcp.servers.remove' && params.profile === 'researcher') {
        const { JsonRpcGatewayError } = await import('../../hermes/vendor/json-rpc-channel');
        throw new JsonRpcGatewayError("server 'calendar-personal' not found", { code: 4064 });
      }
      return {};
    });
    const result = await removeCalendar({ slug: 'personal' });
    expect(result.success).toBe(true);
    expect(envOf('')).not.toContain('BOUNDARY_CALENDAR');
    expect(envOf('')).toContain('OPENAI_API_KEY=x');
    expect(h.compose.mock.calls.some(([a]) => (a as string[]).join(' ') === '--profile calendar rm -sf caldav-mcp')).toBe(true);
  });

  it('lists offer_setup again before reloading once the last calendar goes', async () => {
    await connect({ assistant: 'read' });
    h.events = [];
    await removeCalendar({ slug: 'personal' });
    expect(h.events).toEqual(['listing:0', 'reload']);
  });
});

const REJECTED = { stdout: 'CALDAV_PROBE {"status": "rejected"}', stderr: '', code: 0 };

describe('sign-in checks', () => {
  it('a rejected check turns the account red and keeps the date it last worked', async () => {
    const connected = await connect({ assistant: 'read' });
    const workedAt = connected.account?.lastOkAt;
    h.composeWithInput.mockResolvedValue(REJECTED);
    const result = await recheckCalendar({ slug: 'personal' });
    expect(result.account?.lastCheck?.status).toBe('rejected');
    expect(result.account?.lastOkAt).toBe(workedAt);
  });

  it('doesn’t record a check that couldn’t run', async () => {
    await connect({ assistant: 'read' });
    h.composeWithInput.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 });
    const result = await recheckCalendar({ slug: 'personal' });
    expect(result.success).toBe(false);
    expect((h.storeData.accounts as Array<{ lastCheck: { status: string } }>)[0].lastCheck.status).toBe('ok');
  });

  it('the tab-open check tests every account', async () => {
    await connect({ assistant: 'read' });
    h.composeWithInput.mockClear().mockResolvedValue(REJECTED);
    const result = await recheckAllCalendars();
    expect(h.composeWithInput).toHaveBeenCalledTimes(1);
    expect(result.accounts[0].lastCheck?.status).toBe('rejected');
  });

  it('the daily check skips accounts checked within the day', async () => {
    await connect({ assistant: 'read' });
    h.composeWithInput.mockClear().mockResolvedValue(REJECTED);
    await runDailyCalendarCheck(Date.now() + 60 * 60_000);
    expect(h.composeWithInput).not.toHaveBeenCalled();

    await runDailyCalendarCheck(Date.now() + 25 * 60 * 60_000);
    expect(h.composeWithInput).toHaveBeenCalledTimes(1);
    expect((h.storeData.accounts as Array<{ lastCheck: { status: string } }>)[0].lastCheck.status).toBe('rejected');
  });
});

describe('replaceCalendarPassword', () => {
  const NEW_PW = 'qrst-uvwx-yzab-cdef';

  it('writes nothing when the new password is rejected', async () => {
    await connect({ assistant: 'read', researcher: 'read' });
    h.composeWithInput.mockResolvedValue(REJECTED);
    h.requestMcp.mockClear();
    const result = await replaceCalendarPassword({ slug: 'personal', password: NEW_PW });
    expect(result).toMatchObject({ success: false, error: 'The server didn’t accept that password.' });
    expect(envOf('')).toContain(`BOUNDARY_CALENDAR_PERSONAL_PASSWORD=${PW}`);
    expect(h.requestMcp).not.toHaveBeenCalledWith('reload.mcp', { confirm: true });
  });

  it('re-provisions every agent with access and reloads, without a restart', async () => {
    await connect({ assistant: 'read', researcher: 'read' });
    h.composeWithInput.mockResolvedValue(REJECTED);
    await recheckCalendar({ slug: 'personal' });

    h.composeWithInput.mockResolvedValue({ stdout: OK_PROBE, stderr: '', code: 0 });
    h.requestMcp.mockClear();
    h.compose.mockClear();
    const result = await replaceCalendarPassword({ slug: 'personal', password: NEW_PW });
    expect(result).toMatchObject({ success: true, account: { passwordTail: 'cdef', lastCheck: { status: 'ok' } } });
    for (const profile of ['', 'researcher']) {
      expect(envOf(profile)).toContain(`BOUNDARY_CALENDAR_PERSONAL_PASSWORD=${NEW_PW}`);
      expect(envOf(profile)).not.toContain(PW);
    }
    expect(h.requestMcp).toHaveBeenCalledWith('reload.mcp', { confirm: true });
    expect(h.compose.mock.calls.some(([a]) => (a as string[]).includes('restart'))).toBe(false);
    expect(configSets().every((s) => !JSON.stringify(s.entry).includes(NEW_PW))).toBe(true);
  });

  it('refuses a password Hermes can’t read back', async () => {
    await connect({ assistant: 'read' });
    const result = await replaceCalendarPassword({ slug: 'personal', password: 'pa$$word' });
    expect(result.success).toBe(false);
    expect(envOf('')).toContain(`BOUNDARY_CALENDAR_PERSONAL_PASSWORD=${PW}`);
  });
});
