import { HOST_TOOLS } from './toolCatalog';

/**
 * The slice of MCP the host bridge speaks: Streamable HTTP, POST only, one JSON-RPC message per
 * request, answered with `application/json` (no SSE stream, no session id). That is enough for
 * initialize, ping, tools/list and tools/call, and keeps the security-critical surface small.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_INFO = { name: 'boundary-host', version: '0.1.0' };

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>;

/** `undefined` means the message was a notification and gets no response body. */
export type McpReply = { status: number; body?: unknown };

const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

function error(id: JsonRpcRequest['id'], code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function result(id: JsonRpcRequest['id'], value: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result: value } };
}

export function parseJsonRpc(raw: string): JsonRpcRequest | McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.parse, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'Batches are not supported' } } };
  }
  const msg = parsed as Partial<JsonRpcRequest>;
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.invalidRequest, message: 'Invalid request' } } };
  }
  return msg as JsonRpcRequest;
}

export function isReply(value: JsonRpcRequest | McpReply): value is McpReply {
  return 'status' in value;
}

export async function handleMcpMessage(msg: JsonRpcRequest, callTool: CallTool): Promise<McpReply> {
  const isNotification = msg.id === undefined;
  if (isNotification) {
    // notifications/initialized, notifications/cancelled, …: nothing to do.
    return { status: 202 };
  }

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : FALLBACK_PROTOCOL_VERSION;
      return result(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Tools that act on the user's own computer through Boundary. Each one may ask the user " +
          'to approve it in Boundary first.',
      });
    }
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, { tools: HOST_TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args)) {
        return error(msg.id, JSON_RPC_ERRORS.invalidParams, 'tools/call needs a name and an arguments object');
      }
      if (!HOST_TOOLS.some((tool) => tool.name === name)) {
        return error(msg.id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
      }
      return result(msg.id, await callTool(name, args as Record<string, unknown>));
    }
    default:
      return error(msg.id, JSON_RPC_ERRORS.methodNotFound, `Method not found: ${msg.method}`);
  }
}
