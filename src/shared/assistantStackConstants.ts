import type { AssistantStackPorts } from './types/assistantStack';

/** Compose project name Boundary always manages (never the developer's default project). */
export const BOUNDARY_ASSISTANT_PROJECT_NAME = 'boundary-assistant';

/** Profiles Boundary brings up on every ensure/stop (not ollama/calendar/signal/searxng-prod). */
export const BOUNDARY_ASSISTANT_COMPOSE_PROFILES = [
  'core',
  'rag',
  'automation',
  'coding',
] as const;

export type BoundaryAssistantComposeProfile =
  (typeof BOUNDARY_ASSISTANT_COMPOSE_PROFILES)[number];

/** Comma-joined value for COMPOSE_PROFILES. */
export const BOUNDARY_ASSISTANT_COMPOSE_PROFILES_CSV =
  BOUNDARY_ASSISTANT_COMPOSE_PROFILES.join(',');

/** @deprecated Prefer BOUNDARY_ASSISTANT_COMPOSE_PROFILES — kept for hermes-only setup run. */
export const BOUNDARY_ASSISTANT_COMPOSE_PROFILE = 'core';

export const BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE = 'docker-compose.yml';

export const BOUNDARY_ASSISTANT_OVERLAY_FILENAME = 'docker-compose.boundary.yml';

/** Public agent stack Boundary provisions for end users (not a sibling checkout). */
export const SOVEREIGN_AGENT_STACK_REPO = 'kaxline/sovereign-agent-stack';

/**
 * Pinned git ref for the archive Boundary downloads: the commit a release tag points at,
 * so a moved tag can't change what installs get. Read the stack's CHANGELOG.md before
 * bumping; a minor version can add services, required keys, host requirements or mounts.
 */
export const SOVEREIGN_AGENT_STACK_VERSION = 'v0.3.4';
export const SOVEREIGN_AGENT_STACK_REF = '0c34fd2d8179951f3b910990d6304ab54f737723';

/**
 * SHA-256 of the GitHub zip for SOVEREIGN_AGENT_STACK_REF; a download that doesn't match is
 * refused. Bump it with the ref:
 *   curl -sL https://github.com/kaxline/sovereign-agent-stack/archive/<ref>.zip | shasum -a 256
 */
export const SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256 =
  'eabee1c4782eaf09cd8cf9eec5e6af01af9544ce03ed4230d031cd284f0171d2';

/**
 * Second-copy settings from the stack's docs/extending.md, passed in the compose
 * environment: every container_name gets the prefix, built images get their own tags.
 */
export const BOUNDARY_ASSISTANT_CONTAINER_PREFIX = 'boundary-';
export const BOUNDARY_ASSISTANT_IMAGE_PREFIX = 'boundary-assistant';

/**
 * Where Hermes runs shell, file and execute_code tools. `ssh` (upstream's default,
 * compose/hermes/terminal-ssh.yml) runs them in the hermes-worker container, which holds
 * no secrets and can't read data/hermes. `local` runs them in the hermes container.
 */
export const BOUNDARY_HERMES_TERMINAL_BACKEND: 'ssh' | 'local' = 'ssh';

export const SOVEREIGN_AGENT_STACK_GITHUB_URL = `https://github.com/${SOVEREIGN_AGENT_STACK_REPO}`;

export function sovereignAgentStackArchiveUrl(
  ref: string = SOVEREIGN_AGENT_STACK_REF
): string {
  return `https://github.com/${SOVEREIGN_AGENT_STACK_REPO}/archive/${encodeURIComponent(ref)}.zip`;
}

/** Non-interactive setup.sh workspace defaults for Boundary-managed installs. */
export const BOUNDARY_SETUP_WORKSPACE = 'boundary-kb';
export const BOUNDARY_SETUP_WEBUI_TITLE = 'Boundary Knowledge Base';

/** Added to default ports when those are already bound (dual-stack with a developer stack). */
export const BOUNDARY_ASSISTANT_PORT_OFFSET = 10_000;

export const DEFAULT_ASSISTANT_STACK_PORTS: AssistantStackPorts = {
  gateway: 8642,
  apiServer: 8643,
  dashboard: 9119,
  webui: 8787,
  searxng: 8080,
  lightrag: 9621,
  neo4jHttp: 7474,
  neo4jBolt: 7687,
  opencode: 4096,
  gptResearcher: 8000,
  n8n: 5678,
  llmProxyAdmin: 4001,
};

/** Host publish ports for a given isolation mode (all keys, never a partial mix). */
export function portsForIsolationMode(
  isolationMode: import('./types/assistantStack').AssistantStackIsolationMode
): AssistantStackPorts {
  if (isolationMode === 'offset-ports') {
    const offset = BOUNDARY_ASSISTANT_PORT_OFFSET;
    return {
      gateway: DEFAULT_ASSISTANT_STACK_PORTS.gateway + offset,
      apiServer: DEFAULT_ASSISTANT_STACK_PORTS.apiServer + offset,
      dashboard: DEFAULT_ASSISTANT_STACK_PORTS.dashboard + offset,
      webui: DEFAULT_ASSISTANT_STACK_PORTS.webui + offset,
      searxng: DEFAULT_ASSISTANT_STACK_PORTS.searxng + offset,
      lightrag: DEFAULT_ASSISTANT_STACK_PORTS.lightrag + offset,
      neo4jHttp: DEFAULT_ASSISTANT_STACK_PORTS.neo4jHttp + offset,
      neo4jBolt: DEFAULT_ASSISTANT_STACK_PORTS.neo4jBolt + offset,
      opencode: DEFAULT_ASSISTANT_STACK_PORTS.opencode + offset,
      gptResearcher: DEFAULT_ASSISTANT_STACK_PORTS.gptResearcher + offset,
      n8n: DEFAULT_ASSISTANT_STACK_PORTS.n8n + offset,
      llmProxyAdmin: DEFAULT_ASSISTANT_STACK_PORTS.llmProxyAdmin + offset,
    };
  }
  return { ...DEFAULT_ASSISTANT_STACK_PORTS };
}

/** Container names assigned by Boundary's compose overlay (not the assistant base file). */
export const BOUNDARY_ASSISTANT_CONTAINER_NAMES = [
  'boundary-hermes',
  'boundary-hermes-webui',
  'boundary-searxng',
  'boundary-lightrag',
  'boundary-lightrag-neo4j',
  'boundary-gpt-researcher',
  'boundary-n8n',
  'boundary-opencode',
  'boundary-opencode-mcp',
  'boundary-llm-proxy',
  'boundary-hermes-worker',
] as const;

export const HERMES_CONFIG_PROFILES = ['', 'api-server', 'browser'] as const;

export const ASSISTANT_STACK_UP_TIMEOUT_MS = 600_000;
export const ASSISTANT_STACK_HEALTH_TIMEOUT_MS = 300_000;
export const ASSISTANT_STACK_HEALTH_INTERVAL_MS = 2_000;
/** How long dev:local-stack waits for a `make up` that is still starting (bootstraps are slow). */
export const LIVE_LOCAL_STACK_START_TIMEOUT_MS = 900_000;
export const ASSISTANT_STACK_DOWN_TIMEOUT_MS = 120_000;

/** CLI argv fragments: `--profile core --profile rag …` */
export function buildComposeProfileArgs(
  profiles: readonly string[] = BOUNDARY_ASSISTANT_COMPOSE_PROFILES
): string[] {
  return profiles.flatMap((profile) => ['--profile', profile]);
}
