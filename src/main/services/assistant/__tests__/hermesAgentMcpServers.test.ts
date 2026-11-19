import { describe, expect, it } from 'vitest';
import { loadYaml } from '../../loadYaml';
import { AGENT_MCP_SERVERS, agentEnvValues, defaultMcpServerEntries, mcpEnvRefs } from '../hermesAgentMcpServers';

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

describe('mcpEnvRefs', () => {
  it('finds each ${VAR} and ${env:VAR} in the entries, once', () => {
    // The 0.3.15 bootstrap writes `todos` with the token as a reference (stack docs/todo.md).
    const entries: Array<[string, unknown]> = [
      ['mcp_servers.todos', { url: 'http://vikunja:3456/api/v2/mcp', headers: { Authorization: 'Bearer ${TODOS_KEY}' } }],
      ['mcp_servers.searxng', { url: 'http://searxng-mcp:8000/mcp', headers: { 'X-Key': '${env:SEARX_KEY}', Other: 'Bearer ${TODOS_KEY}' } }],
      ['mcp_servers.opencode', { url: 'http://opencode-mcp:8000/sse', tools: { include: ['a', '${NOT VALID}'] } }],
    ];
    expect(mcpEnvRefs(entries)).toEqual(['TODOS_KEY', 'SEARX_KEY']);
  });

  it('finds none in entries with literal values', () => {
    expect(mcpEnvRefs([['mcp_servers.todos', loadYaml(TODOS_YAML)]])).toEqual([]);
  });
});

describe('agentEnvValues', () => {
  it('takes only the names the default profile sets, and never an empty value', () => {
    expect(agentEnvValues({ TODOS_KEY: 'rw', OTHER: 'x', EMPTY: '' }, ['TODOS_KEY', 'EMPTY', 'MISSING'])).toEqual({
      TODOS_KEY: 'rw',
    });
  });
});
