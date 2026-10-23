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
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4),
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

vi.mock('../../hermes/hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({ requestMcp: h.requestMcp }),
}));

import {
  connectCalendar,
  removeCalendar,
  setCalendarAccess,
  testCalendarSignIn,
} from '../calendarService';
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
  h.requestMcp.mockReset().mockImplementation(async (method: string) =>
    method === 'mcp.servers.status'
      ? { servers: [{ name: 'calendar-personal', connected: true, status: 'connected', tools: 12 }] }
      : {}
  );
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

  it('does not offer change access in this phase', async () => {
    await connect({ assistant: 'change' });
    expect(configSets()).toHaveLength(0);
    expect(envOf('')).not.toContain('BOUNDARY_CALENDAR');
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
    // The service reads and writes real files before it starts polling, so keep the clock moving.
    for (let i = 0; i < 100 && !settled; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    vi.useRealTimers();
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
});
