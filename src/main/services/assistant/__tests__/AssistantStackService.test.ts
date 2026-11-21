import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rewriteLlmUrlForContainer } from '../rewriteLlmUrlForContainer';
import {
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
  BOUNDARY_ASSISTANT_PORT_OFFSET,
  BOUNDARY_ASSISTANT_PROJECT_NAME,
  DEFAULT_ASSISTANT_STACK_PORTS,
  buildComposeProfileArgs,
  portsForIsolationMode,
} from '../../../../shared/assistantStackConstants';
import {
  buildAssistantUiServiceCards,
} from '../../../../shared/assistantUiServices';
import { __test } from '../AssistantStackService';
import { buildEngineOverlayYaml } from '../engineOverlay';
import { V0316_COMPOSE } from './engineOverlayFixture';
import { localStackEndpoints, localStackFiles } from '../../stackHost/localStackHost';

const calDav = vi.hoisted(() => ({
  connected: false,
  macAccess: null as Record<string, 'off' | 'read' | 'change'> | null,
}));
vi.mock('../calendar/calendarStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../calendar/calendarStore')>()),
  hasCalDavAccounts: () => calDav.connected,
  getMacCalendarAccount: () => (calDav.macAccess ? { access: calDav.macAccess } : null),
}));
vi.mock('../hermes/hermesAgentStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hermes/hermesAgentStore')>()),
  listStoredAgents: () => [
    { slug: 'assistant', builtIn: true },
    { slug: 'researcher', builtIn: false },
  ],
}));

describe('rewriteLlmUrlForContainer', () => {
  it('rewrites localhost to host.docker.internal', () => {
    expect(rewriteLlmUrlForContainer('http://localhost:1234/v1')).toBe(
      'http://host.docker.internal:1234/v1'
    );
  });

  it('rewrites 127.0.0.1', () => {
    expect(rewriteLlmUrlForContainer('http://127.0.0.1:11434/v1/')).toBe(
      'http://host.docker.internal:11434/v1'
    );
  });

  it('rewrites 0.0.0.0, which the slot classifier treats as local', () => {
    expect(rewriteLlmUrlForContainer('http://0.0.0.0:8080/v1')).toBe(
      'http://host.docker.internal:8080/v1'
    );
  });

  it('leaves cloud URLs unchanged', () => {
    expect(rewriteLlmUrlForContainer('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1'
    );
  });
});

describe('AssistantStackService helpers', () => {
  it('offsets all ports by BOUNDARY_ASSISTANT_PORT_OFFSET', () => {
    const ports = portsForIsolationMode('offset-ports');
    for (const [key, port] of Object.entries(DEFAULT_ASSISTANT_STACK_PORTS)) {
      expect(ports[key as keyof typeof ports]).toBe(port + BOUNDARY_ASSISTANT_PORT_OFFSET);
    }
    expect(ports.apiServer).toBe(18643);
    expect(ports.webui).toBe(18787);
    expect(ports.dashboard).toBe(19119);
    expect(ports.lightrag).toBe(19621);
    expect(ports.neo4jHttp).toBe(17474);
    expect(ports.n8n).toBe(15678);
    expect(ports.opencode).toBe(14096);
    expect(ports.gptResearcher).toBe(18000);
  });

  it('portsForIsolationMode keeps offset maps complete', () => {
    const offset = portsForIsolationMode('offset-ports');
    expect(offset.gptResearcher).toBe(18000);
    expect(offset.lightrag).toBe(19621);
    expect(offset.webui).toBe(18787);
    expect(portsForIsolationMode('default-ports').gptResearcher).toBe(8000);
  });

  it('maps host publish ports separately from container-internal listen ports', () => {
    const offset = portsForIsolationMode('offset-ports');
    const env = __test.portsToComposeEnv(offset);
    // Read inside the container too: defaults, with Boundary's own publish variables.
    expect(env.BOUNDARY_HERMES_API_HOST_PORT).toBe('18643');
    expect(env.HERMES_API_SERVER_PORT).toBe('8643');
    expect(env.BOUNDARY_LIGHTRAG_HOST_PORT).toBe('19621');
    expect(env.PORT).toBeUndefined();
    // Host-only in the stack (v0.2.0+): set directly.
    expect(env.HERMES_WEBUI_PORT).toBe('18787');
    expect(env.SEARXNG_PORT).toBe('18080');
    expect(env.N8N_HOST_PORT).toBe('15678');
    expect(env.OPENCODE_PORT).toBe('14096');
    expect(env.GPTR_PORT).toBe('18000');
    expect(env.NEO4J_HTTP_HOST_PORT).toBe('17474');
    expect(env.NEO4J_BOLT_HOST_PORT).toBe('17687');
    expect(env.LLM_PROXY_ADMIN_PORT).toBe('14001');
    expect(env.DETECTOR_PORT).toBe('18790');
  });

  describe('pinHostPortsInProjectEnv', () => {
    let root: string;
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('writes the detector port into the stack .env, replacing an earlier value', async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-ports-'));
      fs.writeFileSync(path.join(root, '.env'), 'FOO=1\nDETECTOR_PORT=8790\n');
      await __test.pinHostPortsInProjectEnv(localStackFiles({ stackRoot: root, userContentRoot: () => root }), portsForIsolationMode('offset-ports', 20_000));
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('FOO=1\nDETECTOR_PORT=28790\n');
    });

    it('adds the default when .env has no detector port', async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-ports-'));
      fs.writeFileSync(path.join(root, '.env'), 'FOO=1\n');
      await __test.pinHostPortsInProjectEnv(localStackFiles({ stackRoot: root, userContentRoot: () => root }), DEFAULT_ASSISTANT_STACK_PORTS);
      expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('FOO=1\nDETECTOR_PORT=8790\n');
    });

    it('leaves a stack without .env alone', async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-ports-'));
      await __test.pinHostPortsInProjectEnv(localStackFiles({ stackRoot: root, userContentRoot: () => root }), DEFAULT_ASSISTANT_STACK_PORTS);
      expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    });
  });

  it('always includes project name and both compose files in argv prefix', () => {
    const args = __test.buildProjectArgs('/tmp/docker-compose.boundary.yml');
    expect(args).toEqual([
      '-p',
      BOUNDARY_ASSISTANT_PROJECT_NAME,
      '-f',
      'docker-compose.yml',
      '-f',
      '/tmp/docker-compose.boundary.yml',
    ]);
  });

  describe('syncEngineOverlay', () => {
    let dir = '';
    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });
    const setUp = (compose: string | null) => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-overlay-'));
      const root = path.join(dir, 'project');
      fs.mkdirSync(root);
      if (compose !== null) fs.writeFileSync(path.join(root, 'docker-compose.yml'), compose);
      return { root, overlay: path.join(dir, 'docker-compose.engine.yml') };
    };

    it('writes the overlay on Podman and removes it again on Docker', () => {
      const { root, overlay } = setUp(V0316_COMPOSE);
      expect(__test.syncEngineOverlay('podman', root, overlay)).toBe(overlay);
      expect(fs.readFileSync(overlay, 'utf8')).toBe(buildEngineOverlayYaml('podman', V0316_COMPOSE));
      expect(__test.syncEngineOverlay('docker', root, overlay)).toBeNull();
      expect(fs.existsSync(overlay)).toBe(false);
    });

    it('writes nothing on Podman when the stack has no compose file', () => {
      const { root, overlay } = setUp(null);
      expect(__test.syncEngineOverlay('podman', root, overlay)).toBeNull();
      expect(fs.existsSync(overlay)).toBe(false);
    });
  });

  it('adds the engine overlay last when there is one', () => {
    const args = __test.buildProjectArgs('/tmp/docker-compose.boundary.yml', '/tmp/docker-compose.engine.yml');
    expect(args.slice(-2)).toEqual(['-f', '/tmp/docker-compose.engine.yml']);
  });

  it('builds multi-profile compose args for core+automation+coding+db+research, leaving rag to the LightRAG switch', () => {
    const args = buildComposeProfileArgs();
    expect(args).toEqual([
      '--profile',
      'core',
      '--profile',
      'automation',
      '--profile',
      'coding',
      '--profile',
      'db',
      '--profile',
      'research',
      '--profile',
      'search-gate',
    ]);
    expect(BOUNDARY_ASSISTANT_COMPOSE_PROFILES).toEqual([
      'core',
      'automation',
      'coding',
      'db',
      'research',
      'search-gate',
    ]);
    expect(__test.buildComposeProfileArgs()).toEqual(args);
  });
});

describe('assistantUiServices', () => {
  it('builds LightRAG URL with /webui/ path', () => {
    const endpoints = localStackEndpoints(() => DEFAULT_ASSISTANT_STACK_PORTS);
    const lightrag = buildAssistantUiServiceCards(endpoints.url).find((c) => c.id === 'lightrag');
    expect(lightrag?.url).toBe('http://127.0.0.1:9621/webui/');
  });

  it('resolves all seven product cards including offset ports', () => {
    const offset = portsForIsolationMode('offset-ports');
    const cards = buildAssistantUiServiceCards(localStackEndpoints(() => offset).url);
    expect(cards).toHaveLength(7);
    expect(cards.map((c) => c.id)).toEqual([
      'hermes-webui',
      'searxng',
      'lightrag',
      'neo4j',
      'gpt-researcher',
      'n8n',
      'opencode',
    ]);
    expect(cards.find((c) => c.id === 'hermes-webui')?.url).toBe('http://127.0.0.1:18787/');
    expect(cards.find((c) => c.id === 'lightrag')?.url).toBe('http://127.0.0.1:19621/webui/');
    expect(cards.find((c) => c.id === 'n8n')?.url).toBe('http://127.0.0.1:15678/');
  });
});

describe('isAssistantStackReady', () => {
  afterEach(() => {
    __test.resetReadyForTests();
    vi.unstubAllGlobals();
  });

  it('reports a change in readiness once, not on every check', async () => {
    const { isAssistantStackReady, setAssistantStackReadyCallback } = await import(
      '../AssistantStackService'
    );
    const reports: boolean[] = [];
    setAssistantStackReadyCallback((ready) => reports.push(ready));
    let ok = true;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok })));

    expect(await isAssistantStackReady()).toBe(true);
    expect(await isAssistantStackReady()).toBe(true);
    ok = false;
    expect(await isAssistantStackReady()).toBe(false);
    expect(reports).toEqual([true, false]);
  });
});

describe('waking the bridge entries', () => {
  afterEach(() => {
    calDav.macAccess = null;
  });

  it('wakes only boundary without a Mac account', () => {
    expect(__test.hostBridgeWakeServers()).toEqual(['boundary']);
  });

  it('wakes only boundary while no agent has access to the Mac', () => {
    calDav.macAccess = { assistant: 'off', researcher: 'off' };
    expect(__test.hostBridgeWakeServers()).toEqual(['boundary']);
  });

  it('wakes calendar-mac too when an agent has access to the Mac', () => {
    calDav.macAccess = { assistant: 'off', researcher: 'read' };
    expect(__test.hostBridgeWakeServers()).toEqual(['boundary', 'calendar-mac']);
  });
});

describe('desiredHermesConfig and the Mac calendar entry', () => {
  const bridge = (mcpPort: number) => ({ mcpPort, browserPort: 47002, mcpToken: 'm', browserToken: 'b' });
  const desired = (mcpPort: number) =>
    __test.desiredHermesConfig({
      profiles: ['', 'researcher', 'writer'],
      agents: ['researcher', 'writer'],
      limits: null,
      defaultConfig: null,
      bridge: bridge(mcpPort),
      macCalendarProfiles: new Set(['', 'researcher']),
    });
  const macUrl = (profile: { set: Array<[string, string]> }) =>
    profile.set.find(([key]) => key === 'mcp_servers.calendar-mac.url')?.[1];

  it('re-points calendar-mac entries when the bridge port changes', () => {
    const [main, researcher, writer] = desired(47011);
    expect(macUrl(main)).toBe('http://host.docker.internal:47011/calendar');
    expect(macUrl(researcher)).toBe('http://host.docker.internal:47011/calendar');
    // An agent without access has no entry to re-point.
    expect(macUrl(writer)).toBeUndefined();
  });

  it('gives agent profiles the stack skills folder and leaves the default profile to the stack', () => {
    const [main, researcher] = desired(47011);
    expect(main.listIncludes ?? []).toEqual([]);
    expect(researcher.listIncludes).toEqual([['skills.external_dirs', '/opt/skills']]);
  });

  it('leaves calendar-mac alone while no bridge runs', () => {
    const plan = __test.desiredHermesConfig({
      profiles: [''],
      agents: [],
      limits: null,
      defaultConfig: null,
      bridge: null,
      macCalendarProfiles: new Set(['']),
    });
    expect(macUrl(plan[0])).toBeUndefined();
  });
});

describe('the calendar compose profile', () => {
  const profiles = async () => (await __test.boundaryComposeProfilesCsv()).split(',');

  it('is left out while only the Mac account is connected', async () => {
    calDav.connected = false;
    expect(await profiles()).not.toContain('calendar');
  });

  it('is included once a CalDAV account is connected', async () => {
    calDav.connected = true;
    expect(await profiles()).toContain('calendar');
  });
});
