import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HOST_TOOLS } from './toolCatalog';
import { removeEnvLines, upsertEnvLines } from '../assistant/stackEnv';

/**
 * What Boundary writes into Hermes so it can reach the host bridge (ADR 0027 §3), in every
 * profile Boundary writes model settings to: the stack's and the agents'.
 *
 * - Tokens go into each profile's `.env`, which Hermes loads as that profile's secrets. Hermes
 *   resolves `${BOUNDARY_BRIDGE_TOKEN}` in the MCP headers from there, so the MCP token is not
 *   in `config.yaml`, the compose environment or `docker inspect`.
 * - `config.yaml` gets an `mcp_servers.boundary` entry that points at the bridge.
 * - When the user turns the browser on, `browser.cdp_url` refers to the browser token as
 *   `${BOUNDARY_BROWSER_TOKEN}`. Hermes expands it from the profile's own `.env` each time it reads
 *   the browser section, so the token isn't in `config.yaml` either.
 * - `api-server` gets no `browser.cdp_url`: it's the stack's unattended identity (n8n, scripts),
 *   and the browser is signed in to the user's sites.
 */

export const HERMES_BRIDGE_SERVER_KEY = 'boundary';
const BRIDGE_TOKEN_ENV = 'BOUNDARY_BRIDGE_TOKEN';
const BROWSER_TOKEN_ENV = 'BOUNDARY_BROWSER_TOKEN';
/** Above the bridge's 120 s approval timeout, so a slow approval reaches Hermes as "denied". */
const HERMES_BRIDGE_CALL_TIMEOUT_S = 180;
/**
 * The stack's guidance for an MCP server an app hosts (assistant docs/extending.md): a session
 * counts as healthy after one keepalive, a parked server is retried this often (the stack's
 * overlay; plain Hermes ignores the key), and connect_timeout stays at Hermes's 60 s so a bridge
 * that's down when Hermes starts is parked, where a wake can reach it, rather than abandoned.
 */
export const HERMES_BRIDGE_KEEPALIVE_S = 15;
export const HERMES_BRIDGE_PARKED_RETRY_S = 15;
const HERMES_BRIDGE_CONNECT_TIMEOUT_S = 60;

/**
 * Fingerprint of the tool list, sent as a header Hermes ignores. Hermes keeps the tool list it
 * fetched when it connected, so a changed catalog has to change its config; that triggers the
 * restart that makes it list the tools again.
 */
const TOOL_CATALOG_HEADER = 'X-Boundary-Tool-Catalog';
export function toolCatalogFingerprint(tools: unknown = HOST_TOOLS): string {
  // The prefix keeps `hermes config set` from reading an all-digit hash as a number.
  return `tools-${createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 12)}`;
}

function hostBridgeMcpUrl(mcpPort: number): string {
  return `http://host.docker.internal:${mcpPort}/mcp`;
}

/** `hermes config set` pairs for one profile. The header keeps `${…}` literally for Hermes. */
export function hostBridgeHermesConfigSets(mcpPort: number): Array<[string, string]> {
  const base = `mcp_servers.${HERMES_BRIDGE_SERVER_KEY}`;
  return [
    [`${base}.url`, hostBridgeMcpUrl(mcpPort)],
    [`${base}.headers.Authorization`, `Bearer \${${BRIDGE_TOKEN_ENV}}`],
    [`${base}.headers.${TOOL_CATALOG_HEADER}`, toolCatalogFingerprint()],
    [`${base}.timeout`, String(HERMES_BRIDGE_CALL_TIMEOUT_S)],
    [`${base}.connect_timeout`, String(HERMES_BRIDGE_CONNECT_TIMEOUT_S)],
    [`${base}.keepalive_interval`, String(HERMES_BRIDGE_KEEPALIVE_S)],
    [`${base}.parked_retry_interval`, String(HERMES_BRIDGE_PARKED_RETRY_S)],
  ];
}

/** Host path of a profile's `.env` under the stack data root. `''` is the default profile. */
export function hermesProfileEnvPath(dataRoot: string, profile: string): string {
  return profile === ''
    ? path.join(dataRoot, 'hermes', '.env')
    : path.join(dataRoot, 'hermes', 'profiles', profile, '.env');
}

/** Host path of a profile's `config.yaml` under the stack data root. `''` is the default profile. */
export function hermesProfileConfigPath(dataRoot: string, profile: string): string {
  return path.join(path.dirname(hermesProfileEnvPath(dataRoot, profile)), 'config.yaml');
}

/** Path Hermes's CDP driver connects to on the browser listener; also how Boundary's URL is recognised. */
const BOUNDARY_CDP_PATH = '/devtools/browser/boundary';

/**
 * `browser.cdp_url` for Boundary's browser. The `/devtools/browser/` path makes Hermes use the URL
 * as-is (no `/json/version` discovery, which the relay doesn't serve). The token rides in the
 * query because the driver can't send headers; Hermes masks CDP query strings in its logs. The
 * token is a reference Hermes expands from the profile's `.env` (base64url, so it needs no
 * escaping in a URL).
 */
export function hostBridgeCdpUrl(browserPort: number): string {
  return `ws://host.docker.internal:${browserPort}${BOUNDARY_CDP_PATH}?token=\${${BROWSER_TOKEN_ENV}}`;
}

/** Profiles that never get Boundary's browser: the stack's unattended identity. */
const PROFILES_WITHOUT_BROWSER = new Set(['api-server']);

/** Whether `profile` may hold Boundary's `browser.cdp_url`. */
export function profileGetsBoundaryBrowser(profile: string): boolean {
  return !PROFILES_WITHOUT_BROWSER.has(profile);
}

export function isBoundaryCdpUrl(value: unknown): boolean {
  return typeof value === 'string' && value.includes(BOUNDARY_CDP_PATH);
}

/**
 * Write both tokens into each profile's `.env`. Profiles whose folder doesn't exist yet are
 * skipped (Hermes creates them at bootstrap). Returns the profiles written and whether any file
 * actually changed.
 */
export async function writeHostBridgeTokensToProfiles(
  dataRoot: string,
  profiles: readonly string[],
  tokens: { mcp: string; browser: string }
): Promise<{ written: string[]; changed: boolean }> {
  return editProfileEnvs(dataRoot, profiles, (current) =>
    upsertEnvLines(current, { [BRIDGE_TOKEN_ENV]: tokens.mcp, [BROWSER_TOKEN_ENV]: tokens.browser })
  );
}

/**
 * Write `values` into each profile's `.env`, as {@link writeHostBridgeTokensToProfiles} writes the
 * bridge's tokens. Profiles whose folder doesn't exist yet are skipped. Returns whether any file
 * changed; nothing with values is logged.
 */
export async function writeEnvValuesToProfiles(
  dataRoot: string,
  profiles: readonly string[],
  values: Record<string, string>
): Promise<{ changed: boolean }> {
  if (Object.keys(values).length === 0) return { changed: false };
  const { changed } = await editProfileEnvs(dataRoot, profiles, (current) => upsertEnvLines(current, values));
  return { changed };
}

/** Drop the lines that set `names` from each profile's `.env`. Returns whether any file changed. */
export async function removeEnvValuesFromProfiles(
  dataRoot: string,
  profiles: readonly string[],
  names: readonly string[]
): Promise<{ changed: boolean }> {
  if (names.length === 0) return { changed: false };
  const { changed } = await editProfileEnvs(dataRoot, profiles, (current) => removeEnvLines(current, names));
  return { changed };
}

/** Apply `edit` to each existing profile's `.env`. Returns the profiles it read and whether a file changed. */
async function editProfileEnvs(
  dataRoot: string,
  profiles: readonly string[],
  edit: (current: string) => string
): Promise<{ written: string[]; changed: boolean }> {
  const written: string[] = [];
  let changed = false;
  for (const profile of profiles) {
    const envPath = hermesProfileEnvPath(dataRoot, profile);
    if (!fs.existsSync(path.dirname(envPath))) continue;
    let current = '';
    try {
      current = await fs.promises.readFile(envPath, 'utf8');
    } catch {
      /* new file */
    }
    const next = edit(current);
    if (next !== current) {
      await fs.promises.writeFile(envPath, next, { encoding: 'utf8', mode: 0o600 });
      changed = true;
    }
    written.push(profile);
  }
  return { written, changed };
}
