import { APP_NAME, INSTANCE_NAME } from './buildIdentity';
import type { AssistantStackPorts } from './types/assistantStack';

/** Compose project name Boundary always manages (never the developer's default project). */
export const BOUNDARY_ASSISTANT_PROJECT_NAME = `${INSTANCE_NAME}-assistant`;

/**
 * Profiles Boundary brings up on every ensure/stop (not ollama/calendar/signal/searxng-prod).
 * `rag` (LightRAG and Neo4j) is off unless the user turns it on: compose calls then add
 * {@link LIGHTRAG_COMPOSE_PROFILE}. `db` is the shared Postgres plus SQL MCP for Hermes (stack docs/database.md). `research` is
 * gptr-mcp, which Hermes registers as GPT Researcher tools when GPTR_MCP_ENABLED is 1 (stack
 * docs/gpt-researcher.md); `automation` starts it too, for OpenCode, along with the GPT
 * Researcher API and n8n. n8n is off unless the user turns it on: `up` then names every other
 * service ({@link N8N_COMPOSE_SERVICES}). `search-gate` paces web searches; it goes with
 * {@link BOUNDARY_WEB_SEARCH_URL}. A stack older than a profile ignores the name.
 */
export const BOUNDARY_ASSISTANT_COMPOSE_PROFILES = [
  'core',
  'automation',
  'coding',
  'db',
  'research',
  'search-gate',
] as const;

/**
 * n8n, its one-shot seed job and the GPT Researcher API, which only n8n's research workflow
 * calls (n8n waits for it at start). All three are in the `automation` profile; Hermes's and
 * OpenCode's GPT Researcher tools are `gptr-mcp`, which `research` also starts. Compose pulls
 * the image of every service in an active profile, even one scaled to 0, so with n8n off `up`
 * lists the profile's other services by name instead of dropping the profile.
 */
export const N8N_COMPOSE_SERVICES = ['n8n-import', 'n8n', 'gpt-researcher'] as const;

/**
 * LightRAG's profile. It holds lightrag, its MCP sidecar and Neo4j, its graph store; nothing
 * outside it needs them (n8n's `depends_on` on lightrag and neo4j is `required: false`).
 */
export const LIGHTRAG_COMPOSE_PROFILE = 'rag';

/** The `rag` profile's services, sidecar first so `rm` stops it before what it calls. */
export const LIGHTRAG_COMPOSE_SERVICES = ['lightrag-mcp', 'lightrag', 'neo4j'] as const;

/** @deprecated Prefer BOUNDARY_ASSISTANT_COMPOSE_PROFILES — kept for hermes-only setup run. */
export const BOUNDARY_ASSISTANT_COMPOSE_PROFILE = 'core';

export const BOUNDARY_ASSISTANT_BASE_COMPOSE_FILE = 'docker-compose.yml';

export const BOUNDARY_ASSISTANT_OVERLAY_FILENAME = 'docker-compose.boundary.yml';

/** Public agent stack Boundary provisions for end users (not a sibling checkout). */
const SOVEREIGN_AGENT_STACK_REPO = 'kaxline/sovereign-agent-stack';

/**
 * Pinned git ref for the archive Boundary downloads: the commit a release tag points at,
 * so a moved tag can't change what installs get. Read the stack's CHANGELOG.md before
 * bumping; a minor version can add services, required keys, host requirements or mounts.
 */
export const SOVEREIGN_AGENT_STACK_VERSION = 'v0.3.17';
export const SOVEREIGN_AGENT_STACK_REF = '3e11babf21f65ccff18d4f3dbaf72a4697a2da8f';

/**
 * SHA-256 of the GitHub zip for SOVEREIGN_AGENT_STACK_REF; a download that doesn't match is
 * refused. Bump it with the ref:
 *   curl -sL https://github.com/kaxline/sovereign-agent-stack/archive/<ref>.zip | shasum -a 256
 */
export const SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256 =
  'c7262558632b0d5d12e4199b8a281c1f004d911e996f08a0a06596f246db3f0e';

/**
 * SHA-256 of the release tarball for SOVEREIGN_AGENT_STACK_VERSION
 * (`sovereign-agent-stack-<version>.tar.gz`, a GitHub release asset), which a stack host reached
 * over SSH installs from. Bump it with the version, from the release's `.sha256` asset.
 */
export const SOVEREIGN_AGENT_STACK_RELEASE_SHA256 =
  '44ebb6a616e19eebb1782afa411a53278cb716069b53f469d52e0f938065980a';

/**
 * Second-copy settings from the stack's docs/extending.md, passed in the compose
 * environment: every container_name gets the prefix, built images get their own tags.
 */
export const BOUNDARY_ASSISTANT_CONTAINER_PREFIX = `${INSTANCE_NAME}-`;
export const BOUNDARY_ASSISTANT_IMAGE_PREFIX = `${INSTANCE_NAME}-assistant`;

/**
 * Where Hermes runs shell, file and execute_code tools in Boundary's stack. `ssh` (upstream's
 * default, compose/hermes/terminal-ssh.yml) runs them in the hermes-worker container, which
 * holds no secrets and can't read data/hermes. Boundary always runs it.
 */
export const BOUNDARY_HERMES_TERMINAL_BACKEND = 'ssh';

/**
 * Where the stack's search clients (mcp-searxng, GPT Researcher, gptr-mcp) send web searches.
 * The `search-gate` service sends each query to one SearXNG engine at a time and caches results
 * (stack docs/searxng.md). It runs only with the `search-gate` profile, which Boundary always
 * passes alongside this URL.
 */
export const BOUNDARY_WEB_SEARCH_URL = 'http://search-gate:8080';

export const SOVEREIGN_AGENT_STACK_GITHUB_URL = `https://github.com/${SOVEREIGN_AGENT_STACK_REPO}`;

export function sovereignAgentStackArchiveUrl(
  ref: string = SOVEREIGN_AGENT_STACK_REF
): string {
  return `https://github.com/${SOVEREIGN_AGENT_STACK_REPO}/archive/${encodeURIComponent(ref)}.zip`;
}

/** The release tarball's name, which is also its top-level folder: `sovereign-agent-stack-v0.3.17`. */
export function sovereignAgentStackReleaseName(version: string = SOVEREIGN_AGENT_STACK_VERSION): string {
  return `sovereign-agent-stack-${version}`;
}

/** Where a release's tarball is published, as the stack's `install.sh` downloads it. */
export function sovereignAgentStackReleaseUrl(version: string = SOVEREIGN_AGENT_STACK_VERSION): string {
  const v = encodeURIComponent(version);
  return `https://github.com/${SOVEREIGN_AGENT_STACK_REPO}/releases/download/${v}/${sovereignAgentStackReleaseName(version)}.tar.gz`;
}

/** Non-interactive setup.sh workspace defaults for Boundary-managed installs. */
export const BOUNDARY_SETUP_WORKSPACE = 'boundary-kb';
export const BOUNDARY_SETUP_WEBUI_TITLE = `${APP_NAME} Knowledge Base`;

/** Added to default ports when those are already bound (dual-stack with a developer stack). */
export const BOUNDARY_ASSISTANT_PORT_OFFSET = 10_000;

/**
 * Offsets tried in order when the defaults are taken or skipped. The last one keeps every port
 * below macOS's ephemeral range (49152), where outgoing connections could take them.
 */
export const BOUNDARY_ASSISTANT_PORT_OFFSETS = [BOUNDARY_ASSISTANT_PORT_OFFSET, 20_000, 30_000] as const;

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
  detector: 8790,
};

/** Host publish ports for a given isolation mode (all keys, never a partial mix). */
export function portsForIsolationMode(
  isolationMode: import('./types/assistantStack').AssistantStackIsolationMode,
  portOffset: number = BOUNDARY_ASSISTANT_PORT_OFFSET
): AssistantStackPorts {
  const offset = isolationMode === 'offset-ports' ? portOffset : 0;
  return Object.fromEntries(
    Object.entries(DEFAULT_ASSISTANT_STACK_PORTS).map(([key, port]) => [key, port + offset])
  ) as AssistantStackPorts;
}

/**
 * Boundary's ids for its containers. The names on the runtime carry this build's prefix: convert
 * with {@link runtimeContainerName} and {@link containerIdFromRuntimeName}.
 */
export const BOUNDARY_ASSISTANT_CONTAINER_NAMES = [
  'boundary-hermes',
  'boundary-hermes-webui',
  'boundary-searxng',
  'boundary-lightrag',
  'boundary-lightrag-neo4j',
  'boundary-gpt-researcher',
  'boundary-gptr-mcp',
  'boundary-n8n',
  'boundary-opencode',
  'boundary-opencode-mcp',
  'boundary-llm-proxy',
  'boundary-hermes-worker',
  'boundary-postgres-db',
  'boundary-sql-mcp-ro',
  'boundary-sql-mcp-rw',
] as const;

const CONTAINER_ID_PREFIX = 'boundary-';

export function runtimeContainerName(id: string): string {
  return `${BOUNDARY_ASSISTANT_CONTAINER_PREFIX}${id.slice(CONTAINER_ID_PREFIX.length)}`;
}

export function containerIdFromRuntimeName(name: string): string {
  return name.startsWith(BOUNDARY_ASSISTANT_CONTAINER_PREFIX)
    ? `${CONTAINER_ID_PREFIX}${name.slice(BOUNDARY_ASSISTANT_CONTAINER_PREFIX.length)}`
    : name;
}

export const HERMES_CONFIG_PROFILES = ['', 'api-server', 'browser'] as const;

export const ASSISTANT_STACK_UP_TIMEOUT_MS = 600_000;
/** `up --build` on a first install or pin change also pulls and builds every image. */
export const ASSISTANT_STACK_BUILD_UP_TIMEOUT_MS = 1_800_000;
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

/**
 * The stack's cap on client context (`compose/hermes/client_context.py` MAX_CONTEXT_CHARS):
 * longer context is refused, so a writing voice or room context has to fit under it.
 */
export const CLIENT_CONTEXT_MAX_CHARS = 16_000;
