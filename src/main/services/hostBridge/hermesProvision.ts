import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load as loadYaml } from 'js-yaml';
import { HOST_TOOLS } from './toolCatalog';

/**
 * What Boundary writes into Hermes so it can reach the host bridge (ADR 0027 §3).
 *
 * - Tokens go into each profile's `.env`, which Hermes loads as that profile's secrets. Hermes
 *   resolves `${BOUNDARY_BRIDGE_TOKEN}` in the MCP headers from there, so no token is in
 *   `config.yaml`, the compose environment or `docker inspect`.
 * - `config.yaml` gets an `mcp_servers.boundary` entry that points at the bridge.
 */

export const HERMES_BRIDGE_SERVER_KEY = 'boundary';
export const BRIDGE_TOKEN_ENV = 'BOUNDARY_BRIDGE_TOKEN';
export const BROWSER_TOKEN_ENV = 'BOUNDARY_BROWSER_TOKEN';
/** Above the bridge's 120 s approval timeout, so a slow approval reaches Hermes as "denied". */
export const HERMES_BRIDGE_CALL_TIMEOUT_S = 180;
/**
 * The stack's guidance for an MCP server an app hosts (assistant docs/extending.md): a session
 * counts as healthy after one keepalive, a parked server is retried this often (the stack's
 * overlay; plain Hermes ignores the key), and connect_timeout stays at Hermes's 60 s so a bridge
 * that's down when Hermes starts is parked, where a wake can reach it, rather than abandoned.
 */
export const HERMES_BRIDGE_KEEPALIVE_S = 15;
export const HERMES_BRIDGE_PARKED_RETRY_S = 15;
export const HERMES_BRIDGE_CONNECT_TIMEOUT_S = 60;

/**
 * Fingerprint of the tool list, sent as a header Hermes ignores. Hermes keeps the tool list it
 * fetched when it connected, so a changed catalog has to change its config; that triggers the
 * restart that makes it list the tools again.
 */
export const TOOL_CATALOG_HEADER = 'X-Boundary-Tool-Catalog';
export function toolCatalogFingerprint(tools: unknown = HOST_TOOLS): string {
  // The prefix keeps `hermes config set` from reading an all-digit hash as a number.
  return `tools-${createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 12)}`;
}

export function hostBridgeMcpUrl(mcpPort: number): string {
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

/** Replace or append `KEY=value` lines, leaving every other line as it was. */
export function upsertEnvLines(contents: string, values: Record<string, string>): string {
  const lines = contents === '' ? [] : contents.replace(/\n$/, '').split('\n');
  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && remaining.has(match[1])) {
      const value = remaining.get(match[1]) as string;
      remaining.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  return `${out.join('\n')}\n`;
}

/** Host path of a profile's `config.yaml` under the stack data root. `''` is the default profile. */
export function hermesProfileConfigPath(dataRoot: string, profile: string): string {
  return path.join(path.dirname(hermesProfileEnvPath(dataRoot, profile)), 'config.yaml');
}

/** Whether a profile's config already has exactly the bridge entry Boundary would write. */
export function hermesBridgeConfigMatches(configYaml: string, mcpPort: number): boolean {
  let parsed: unknown;
  try {
    parsed = loadYaml(configYaml);
  } catch {
    return false;
  }
  const entry = (parsed as { mcp_servers?: Record<string, Record<string, unknown>> } | null)?.mcp_servers?.[
    HERMES_BRIDGE_SERVER_KEY
  ];
  if (!entry) return false;
  const headers = entry.headers as Record<string, unknown> | undefined;
  return (
    entry.url === hostBridgeMcpUrl(mcpPort) &&
    headers?.Authorization === `Bearer \${${BRIDGE_TOKEN_ENV}}` &&
    headers?.[TOOL_CATALOG_HEADER] === toolCatalogFingerprint() &&
    Number(entry.timeout) === HERMES_BRIDGE_CALL_TIMEOUT_S &&
    Number(entry.connect_timeout) === HERMES_BRIDGE_CONNECT_TIMEOUT_S &&
    Number(entry.keepalive_interval) === HERMES_BRIDGE_KEEPALIVE_S &&
    Number(entry.parked_retry_interval) === HERMES_BRIDGE_PARKED_RETRY_S
  );
}

/**
 * Profiles whose `config.yaml` needs the bridge entry written or corrected. Profiles whose
 * folder doesn't exist yet are left out.
 */
export async function profilesNeedingBridgeConfig(
  dataRoot: string,
  profiles: readonly string[],
  mcpPort: number
): Promise<string[]> {
  const out: string[] = [];
  for (const profile of profiles) {
    const configPath = hermesProfileConfigPath(dataRoot, profile);
    if (!fs.existsSync(path.dirname(configPath))) continue;
    let current = '';
    try {
      current = await fs.promises.readFile(configPath, 'utf8');
    } catch {
      /* no config yet */
    }
    if (!hermesBridgeConfigMatches(current, mcpPort)) out.push(profile);
  }
  return out;
}

/** Path Hermes's CDP driver connects to on the browser listener; also how Boundary's URL is recognised. */
export const BOUNDARY_CDP_PATH = '/devtools/browser/boundary';

/**
 * `browser.cdp_url` for Boundary's browser. The `/devtools/browser/` path makes Hermes use the URL
 * as-is (no `/json/version` discovery, which the relay doesn't serve). The token rides in the
 * query because the driver can't send headers; Hermes masks CDP query strings in its logs.
 */
export function hostBridgeCdpUrl(browserPort: number, browserToken: string): string {
  return `ws://host.docker.internal:${browserPort}${BOUNDARY_CDP_PATH}?token=${encodeURIComponent(browserToken)}`;
}

export function isBoundaryCdpUrl(value: unknown): boolean {
  return typeof value === 'string' && value.includes(BOUNDARY_CDP_PATH);
}

/**
 * Profiles whose `browser.cdp_url` should change: to `desired` when it is a URL, or cleared when
 * `desired` is empty and the profile still has Boundary's URL. Someone else's `cdp_url` is never
 * cleared. Profiles whose folder doesn't exist yet are left out.
 */
export async function profilesNeedingBrowserConfig(
  dataRoot: string,
  profiles: readonly string[],
  desired: string
): Promise<string[]> {
  const out: string[] = [];
  for (const profile of profiles) {
    const configPath = hermesProfileConfigPath(dataRoot, profile);
    if (!fs.existsSync(path.dirname(configPath))) continue;
    let current: unknown;
    try {
      const parsed = loadYaml(await fs.promises.readFile(configPath, 'utf8')) as { browser?: { cdp_url?: unknown } } | null;
      current = parsed?.browser?.cdp_url;
    } catch {
      current = undefined;
    }
    const needs = desired ? current !== desired : isBoundaryCdpUrl(current);
    if (needs) out.push(profile);
  }
  return out;
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
    const next = upsertEnvLines(current, {
      [BRIDGE_TOKEN_ENV]: tokens.mcp,
      [BROWSER_TOKEN_ENV]: tokens.browser,
    });
    if (next !== current) {
      await fs.promises.writeFile(envPath, next, { encoding: 'utf8', mode: 0o600 });
      changed = true;
    }
    written.push(profile);
  }
  return { written, changed };
}
