import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_MCP_SERVERS,
  copyDefaultMcpServers,
  parseMcpServerEntry,
} from '../hermesAgentMcpServers';
import { HERMES_CONFIG_SECRET_ENV } from '../hermesConfigSetExec';

const OPENCODE_YAML = `url: http://opencode-mcp:8000/sse
timeout: 600
connect_timeout: 30
tools:
  include:
  - coding_start_task
  - mcp__opencode__coding_start_task
transport: sse
`;

const TODOS_YAML = `url: http://vikunja:3456/api/v2/mcp
timeout: 60
headers:
  Authorization: Bearer todo-secret-123
`;

describe('parseMcpServerEntry', () => {
  it('reads an entry and refuses unset, errors and entries without a url', () => {
    expect(parseMcpServerEntry(OPENCODE_YAML)).toMatchObject({
      url: 'http://opencode-mcp:8000/sse',
      transport: 'sse',
      tools: { include: ['coding_start_task', 'mcp__opencode__coding_start_task'] },
    });
    expect(parseMcpServerEntry('Config key not set: mcp_servers.searxng')).toBeNull();
    expect(parseMcpServerEntry("Error: Profile 'x' does not exist.")).toBeNull();
    expect(parseMcpServerEntry('timeout: 60')).toBeNull();
    expect(parseMcpServerEntry('- a\n- b')).toBeNull();
    expect(parseMcpServerEntry('')).toBeNull();
  });
});

describe('copyDefaultMcpServers', () => {
  it('copies the chosen servers the default profile has, keeping values out of argv', async () => {
    const answers: Record<string, string> = {
      'mcp_servers.opencode': OPENCODE_YAML,
      'mcp_servers.searxng': 'Config key not set: mcp_servers.searxng',
      'mcp_servers.todos': TODOS_YAML,
    };
    const compose = vi.fn(async (args: string[]) => ({
      stdout: args.includes('get') ? (answers[args[args.length - 1]] ?? '') : '',
      stderr: '',
    }));

    expect(await copyDefaultMcpServers(compose, 'orchestrator')).toEqual(['opencode', 'todos']);

    const reads = compose.mock.calls.map(([args]) => args).filter((a) => a.includes('get'));
    // Reads come from the default profile, and only for the chosen servers: mail is never asked for.
    expect(reads.map((a) => a.at(-1))).toEqual(AGENT_MCP_SERVERS.map((n) => `mcp_servers.${n}`));
    expect(reads.every((a) => !a.includes('-p'))).toBe(true);

    const writes = compose.mock.calls.filter(([args]) => args.includes('set'));
    expect(writes).toHaveLength(2);
    for (const [args, options] of writes) {
      expect(args.slice(-6)).toEqual(['hermes', '-p', 'orchestrator', 'config', 'set', expect.stringMatching(/^mcp_servers\./)]);
      expect(JSON.stringify(args)).not.toContain('todo-secret-123');
      expect(options.env?.[HERMES_CONFIG_SECRET_ENV]).toBeDefined();
    }
    expect(JSON.parse(String(writes[1][1].env?.[HERMES_CONFIG_SECRET_ENV]))).toEqual({
      url: 'http://vikunja:3456/api/v2/mcp',
      timeout: 60,
      headers: { Authorization: 'Bearer todo-secret-123' },
    });
  });

  it('never writes to the default profile itself', async () => {
    const compose = vi.fn(async () => ({ stdout: OPENCODE_YAML, stderr: '' }));
    expect(await copyDefaultMcpServers(compose, '')).toEqual([]);
    expect(compose).not.toHaveBeenCalled();
  });
});
