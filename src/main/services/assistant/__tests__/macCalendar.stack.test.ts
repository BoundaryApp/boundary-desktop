/**
 * Stack contract: a `calendar-mac` entry on a Hermes profile reaching the host bridge's
 * `/calendar` route from inside the Hermes container (ADR 0031 §1, ADR 0045). Runs only under
 * `bun run test:stack`.
 *
 * The bridge runs in this process, on synthetic calendars: the calendar helper is started with
 * `--fixture synthetic-calendars/basic.json`, so nothing reads the Mac's real calendars. The
 * entry is written into a temporary Hermes home under the container's /tmp by the settings
 * program, with the agent's token in that profile's `.env`, and the home is removed afterwards.
 * Nothing is written to the stack's data folder.
 *
 * The container-side client is plain JSON-RPC over HTTP with the entry's own URL and header, not
 * Hermes's MCP client, so this case checks reachability, the token and the tool annotations the
 * trust gate reads. It does not run a Hermes turn against the approval queue.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { startBridgeServers, type BridgeServers } from '../../hostBridge/bridgeServer';
import { calendarServerName, macCalendarMcpEntry, MAC_TOKEN_ENV } from '../calendar/calendarModel';
import type { StoredCalendarAccount } from '../calendar/calendarStore';
import { MacCalendarHelper } from '../calendar/macCalendarHelper';
import { callMacCalendarTool, listMacCalendarTools } from '../calendar/macCalendarTools';
import {
  buildHermesConfigApplyInput,
  HERMES_CONFIG_APPLY_ARGS,
  parseHermesConfigApplyOutput,
  planHermesProfileWrites,
} from '../hermesConfigApply';
import { MAC_CALENDAR_CLIENT_PROGRAM, type ClientFailure, type ClientSuccess } from './macCalendarClientProgram';
import { execInHermes, probeStack, pythonJsonInHermes, skipNote, type StackTarget } from './stackHarness';

const probe = await probeStack();

const AGENT = 'contract-agent';
const TOKEN = 'a'.repeat(64);
const TEMP_PREFIX = '/tmp/boundary-stack-mac-calendar.';
const FIXTURE = path.resolve('synthetic-calendars', 'basic.json');
const HELPER = path.resolve('resources', 'calendar-helper', 'boundary-calendar-helper');
const helperBuilt = fs.existsSync(HELPER);

/** The Mac account as the bridge reads it: one agent with change access, one allowed calendar. */
const account = {
  slug: 'mac',
  name: 'This Mac',
  provider: 'mac',
  access: { [AGENT]: 'change' },
  allowedCalendarIds: ['cal-icloud-home'],
} as unknown as StoredCalendarAccount;

describe.skipIf(!probe.ok || !helperBuilt)(
  `calendar-mac entry on the host bridge${probe.ok ? (helperBuilt ? '' : ' (skipped: calendar helper not built)') : skipNote(probe)}`,
  () => {
    const target = (probe.ok ? probe.target : null) as StackTarget;
    let home = '';
    let bridge: BridgeServers | null = null;
    let helper: MacCalendarHelper | null = null;

    beforeAll(async () => {
      helper = new MacCalendarHelper({ binaryPath: HELPER, args: ['--fixture', FIXTURE], spawn, log: () => undefined });
      bridge = await startBridgeServers({
        mcpToken: 'contract-mcp',
        browserToken: 'contract-browser',
        callTool: async () => ({ content: [{ type: 'text', text: 'not used' }], isError: true }),
        calendar: {
          tokens: () => ({ [TOKEN]: AGENT }),
          callTool: (agent, name, args) => callMacCalendarTool(agent, name, args, { helper: helper!, account: () => account }),
          listTools: async () => listMacCalendarTools('change'),
        },
      });
      const made = await execInHermes(target, ['mktemp', '-d', `${TEMP_PREFIX}XXXXXX`]);
      home = made.stdout.trim();
      if (made.code !== 0 || !home.startsWith(TEMP_PREFIX)) {
        throw new Error(`couldn't make a temporary Hermes home in ${target.container}: ${made.stderr.trim()}`);
      }
      const dirs = await execInHermes(target, ['mkdir', '-p', `${home}/profiles/${AGENT}`]);
      if (dirs.code !== 0) throw new Error(`mkdir failed: ${dirs.stderr.trim()}`);
    });

    afterAll(async () => {
      helper?.stop();
      await bridge?.close();
      if (home.startsWith(TEMP_PREFIX)) await execInHermes(target, ['rm', '-rf', '--', home]);
    });

    it('lists tools with the hints the trust gate reads and answers caldav_get_events with the token from the profile', async () => {
      const entry = macCalendarMcpEntry({ mcpPort: bridge!.mcpPort, access: 'change' });
      const key = `mcp_servers.${calendarServerName('mac')}`;
      const writes = planHermesProfileWrites({ profile: AGENT, set: [], entries: [[key, entry]] }, {});
      const pythonAt = HERMES_CONFIG_APPLY_ARGS.indexOf('python3');
      expect(pythonAt).not.toBe(-1);
      const pythonArgs = HERMES_CONFIG_APPLY_ARGS.slice(pythonAt);
      const apply = await execInHermes(target, pythonArgs, {
        input: buildHermesConfigApplyInput([writes]),
        env: { HERMES_HOME: home },
      });
      expect(apply.code).toBe(0);
      expect(parseHermesConfigApplyOutput(apply.stdout)).toEqual([{ profile: AGENT, written: 1 }]);
      const env = await execInHermes(target, ['sh', '-c', 'cat > "$1"', 'sh', `${home}/profiles/${AGENT}/.env`], {
        input: `${MAC_TOKEN_ENV}=${TOKEN}\n`,
      });
      expect(env.code).toBe(0);

      const out = await pythonJsonInHermes<ClientSuccess & ClientFailure>(target, MAC_CALENDAR_CLIENT_PROGRAM, {
        env: { PROFILE_HOME: `${home}/profiles/${AGENT}`, SERVER: calendarServerName('mac') },
      });

      expect(out.error).toBeUndefined();
      // Hermes stored the entry as Boundary wrote it, and the URL points at the bridge's port.
      expect(out.entry).toEqual(loadYaml(JSON.stringify(entry)));
      expect(out.unauthorized).toBe(401);
      const hints = new Map(out.tools.map((t) => [t.name, t.readOnlyHint]));
      for (const tool of listMacCalendarTools('change')) {
        expect(hints.get(tool.name)).toBe(tool.annotations?.readOnlyHint);
      }
      expect(hints.get('caldav_get_events')).toBe(true);
      expect(hints.get('caldav_create_event')).toBe(false);
      expect(out.events.isError).toBe(false);
      expect(out.events.text).toContain('Dentist');
    });
  }
);
