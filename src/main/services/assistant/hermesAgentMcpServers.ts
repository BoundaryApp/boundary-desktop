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

/** `${NAME}` and Cursor-style `${env:NAME}`, as Hermes's `_interpolate_env_vars` reads them. */
const ENV_REF = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Names of the `${VAR}`s the entries reference, in order without duplicates. Hermes resolves each
 * from the profile's own `.env` and refuses a server whose url or headers keep one unresolved
 * (`tools/mcp_tool_config.py`, v0.22.7), so an agent's copied entry needs the values too: the
 * stack's 0.3.15 `todos` entry sends `Bearer ${TODOS_KEY}`.
 */
export function mcpEnvRefs(entries: ReadonlyArray<[string, unknown]>): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(ENV_REF)) names.add(m[1]!);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  for (const [, value] of entries) walk(value);
  return [...names];
}

/**
 * The default profile's values for `names`, leaving out any it doesn't set: an agent then keeps
 * what it has rather than getting an empty value.
 */
export function agentEnvValues(defaultEnv: Record<string, string>, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = defaultEnv[name];
    if (value) out[name] = value;
  }
  return out;
}
