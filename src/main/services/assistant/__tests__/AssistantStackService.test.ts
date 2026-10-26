import { describe, expect, it } from 'vitest';
import { rewriteLlmUrlForContainer } from '../rewriteLlmUrlForContainer';
import {
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES,
  BOUNDARY_ASSISTANT_PORT_OFFSET,
  BOUNDARY_ASSISTANT_PROJECT_NAME,
  DEFAULT_ASSISTANT_STACK_PORTS,
  buildComposeProfileArgs,
} from '../../../../shared/assistantStackConstants';
import {
  buildAssistantUiServiceCards,
  buildServiceUrl,
} from '../../../../shared/assistantUiServices';
import { __test } from '../AssistantStackService';

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

  it('leaves cloud URLs unchanged', () => {
    expect(rewriteLlmUrlForContainer('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1'
    );
  });
});

describe('AssistantStackService helpers', () => {
  it('offsets all ports by BOUNDARY_ASSISTANT_PORT_OFFSET', () => {
    const ports = __test.offsetPorts(DEFAULT_ASSISTANT_STACK_PORTS, BOUNDARY_ASSISTANT_PORT_OFFSET);
    expect(ports.apiServer).toBe(18643);
    expect(ports.webui).toBe(18787);
    expect(ports.dashboard).toBe(19119);
    expect(ports.lightrag).toBe(19621);
    expect(ports.neo4jHttp).toBe(17474);
    expect(ports.n8n).toBe(15678);
    expect(ports.opencode).toBe(14096);
    expect(ports.gptResearcher).toBe(18000);
  });

  it('portsForIsolationMode keeps offset maps complete', async () => {
    const { portsForIsolationMode } = await import('../../../../shared/assistantStackConstants');
    const offset = portsForIsolationMode('offset-ports');
    expect(offset.gptResearcher).toBe(18000);
    expect(offset.lightrag).toBe(19621);
    expect(offset.webui).toBe(18787);
    expect(portsForIsolationMode('default-ports').gptResearcher).toBe(8000);
  });

  it('maps host publish ports separately from container-internal listen ports', () => {
    const offset = __test.offsetPorts(DEFAULT_ASSISTANT_STACK_PORTS, BOUNDARY_ASSISTANT_PORT_OFFSET);
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

  it('builds multi-profile compose args for core+rag+automation+coding+db', () => {
    const args = buildComposeProfileArgs();
    expect(args).toEqual([
      '--profile',
      'core',
      '--profile',
      'rag',
      '--profile',
      'automation',
      '--profile',
      'coding',
      '--profile',
      'db',
    ]);
    expect(BOUNDARY_ASSISTANT_COMPOSE_PROFILES).toEqual([
      'core',
      'rag',
      'automation',
      'coding',
      'db',
    ]);
    expect(__test.buildComposeProfileArgs()).toEqual(args);
  });
});

describe('assistantUiServices', () => {
  it('builds LightRAG URL with /webui/ path', () => {
    expect(buildServiceUrl(DEFAULT_ASSISTANT_STACK_PORTS, 'lightrag', '/webui/')).toBe(
      'http://127.0.0.1:9621/webui/'
    );
  });

  it('resolves all seven product cards including offset ports', () => {
    const offset = __test.offsetPorts(DEFAULT_ASSISTANT_STACK_PORTS, BOUNDARY_ASSISTANT_PORT_OFFSET);
    const cards = buildAssistantUiServiceCards(offset);
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
