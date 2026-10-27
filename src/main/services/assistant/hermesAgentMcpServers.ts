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

/**
 * The listed servers the default profile has (an entry with a url), as `mcp_servers.<name>`
 * entries to write whole into an agent's profile, so a rotated token or a moved URL follows.
 * Entries can carry Authorization headers, so they are never logged.
 */
export function defaultMcpServerEntries(
  defaultConfig: Record<string, unknown> | null | undefined
): Array<[string, Record<string, unknown>]> {
  const servers = defaultConfig?.mcp_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const name of AGENT_MCP_SERVERS) {
    const entry = (servers as Record<string, unknown>)[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const url = (entry as Record<string, unknown>).url;
    if (typeof url !== 'string' || !url.trim()) continue;
    out.push([`mcp_servers.${name}`, entry as Record<string, unknown>]);
  }
  return out;
}
