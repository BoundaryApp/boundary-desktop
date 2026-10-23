import { load as loadYaml } from 'js-yaml';
import { buildHermesConfigGetExec, buildHermesConfigSetExec } from './hermesConfigSetExec';
import type { HermesConfigCompose } from './hermesProfileLimits';

/**
 * MCP servers an agent's profile gets from the default profile. Boundary creates agent profiles
 * fresh (`clone_from: null`), so they start with none, and the stack's bootstrap only registers
 * servers in the profiles it knows about. Hermes gives a profile's sessions every server in its
 * `mcp_servers`, so copying the entry is all it takes.
 *
 * The owner chose this list. Mail stays out on purpose: it reads their real email. The
 * `boundary` host bridge stays out too; Boundary provisions it per profile with its own tokens.
 */
export const AGENT_MCP_SERVERS = ['opencode', 'searxng', 'todos'] as const;

/** The server's entry from `hermes config get mcp_servers.<name>`, or null when unset or unreadable. */
export function parseMcpServerEntry(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text || /^(Config key not set|Error)\b/m.test(text)) return null;
  try {
    const entry = loadYaml(text);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const url = (entry as Record<string, unknown>).url;
    return typeof url === 'string' && url.trim() ? (entry as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Copy each listed server the default profile has into `profile`, replacing the profile's own
 * entry so a rotated token or a moved URL follows. Entries can carry Authorization headers, so
 * they go to Hermes through the environment, never argv, and are never logged. Returns the
 * names copied.
 */
export async function copyDefaultMcpServers(
  compose: HermesConfigCompose,
  profile: string
): Promise<string[]> {
  if (!profile) return [];
  const copied: string[] = [];
  for (const name of AGENT_MCP_SERVERS) {
    const key = `mcp_servers.${name}`;
    const { stdout } = await compose(buildHermesConfigGetExec('', key).args, { timeout: 60_000 });
    const entry = parseMcpServerEntry(stdout);
    if (!entry) continue;
    const { args, env } = buildHermesConfigSetExec(profile, key, JSON.stringify(entry), {
      secret: true,
    });
    await compose(args, { timeout: 60_000, env });
    copied.push(name);
  }
  return copied;
}
