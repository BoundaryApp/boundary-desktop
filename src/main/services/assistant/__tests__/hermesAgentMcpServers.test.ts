import { describe, expect, it } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { AGENT_MCP_SERVERS, defaultMcpServerEntries } from '../hermesAgentMcpServers';

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

describe('defaultMcpServerEntries', () => {
  it("lists the chosen servers the default profile has, whole, and never mail", () => {
    const defaultConfig = {
      mcp_servers: {
        opencode: loadYaml(OPENCODE_YAML),
        todos: loadYaml(TODOS_YAML),
        mail: { url: 'http://mail-mcp:8000/mcp' },
      },
    };
    expect(defaultMcpServerEntries(defaultConfig)).toEqual([
      ['mcp_servers.opencode', loadYaml(OPENCODE_YAML)],
      [
        'mcp_servers.todos',
        { url: 'http://vikunja:3456/api/v2/mcp', timeout: 60, headers: { Authorization: 'Bearer todo-secret-123' } },
      ],
    ]);
    expect(AGENT_MCP_SERVERS).not.toContain('mail');
  });

  it('skips entries without a url and configs without servers', () => {
    expect(defaultMcpServerEntries({ mcp_servers: { opencode: { timeout: 60 }, searxng: 'url: x', todos: ['a'] } })).toEqual([]);
    expect(defaultMcpServerEntries({ mcp_servers: ['a'] })).toEqual([]);
    expect(defaultMcpServerEntries({})).toEqual([]);
    expect(defaultMcpServerEntries(null)).toEqual([]);
    expect(defaultMcpServerEntries(undefined)).toEqual([]);
  });
});
