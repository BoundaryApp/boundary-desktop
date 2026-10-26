import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, isReply, parseJsonRpc, type JsonRpcRequest } from '../mcpProtocol';
import { listedHostTools } from '../toolCatalog';

const msg = (method: string, params?: Record<string, unknown>, id: number | null = 1): JsonRpcRequest => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params ? { params } : {}),
});

describe('handleMcpMessage', () => {
  it('echoes a supported protocol version and falls back for unknown ones', async () => {
    const known = await handleMcpMessage(msg('initialize', { protocolVersion: '2025-03-26' }), vi.fn());
    expect((known.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-03-26');
    const unknown = await handleMcpMessage(msg('initialize', { protocolVersion: '1999-01-01' }), vi.fn());
    expect((unknown.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18');
  });

  it('refuses unknown tools and malformed calls without calling main', async () => {
    const callTool = vi.fn();
    const unknown = await handleMcpMessage(msg('tools/call', { name: 'shell', arguments: {} }), callTool);
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32602);
    const badArgs = await handleMcpMessage(msg('tools/call', { name: 'desktop_notification', arguments: ['x'] }), callTool);
    expect((badArgs.body as { error: { code: number } }).error.code).toBe(-32602);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('lists offer_setup only while no calendar is connected', async () => {
    const names = async (offerCalendarSetup: boolean) => {
      const reply = await handleMcpMessage(msg('tools/list'), vi.fn(), () => listedHostTools({ offerCalendarSetup }));
      return (reply.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    };
    expect(await names(true)).toContain('offer_setup');
    expect(await names(false)).not.toContain('offer_setup');
    expect(await names(false)).toContain('desktop_notification');
  });

  it('still passes an offer_setup call to main after the listing drops it', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    await handleMcpMessage(msg('tools/call', { name: 'offer_setup', arguments: { kind: 'calendar' } }), callTool, () =>
      listedHostTools({ offerCalendarSetup: false })
    );
    expect(callTool).toHaveBeenCalledWith('offer_setup', { kind: 'calendar' });
  });

  it('answers unknown methods with method-not-found', async () => {
    const reply = await handleMcpMessage(msg('resources/list'), vi.fn());
    expect((reply.body as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('treats a message without an id as a notification', async () => {
    expect(await handleMcpMessage(msg('tools/call', { name: 'desktop_notification' }, null), vi.fn())).toEqual({ status: 202 });
  });
});

describe('parseJsonRpc', () => {
  it('rejects bad JSON, batches and non-2.0 messages', () => {
    for (const raw of ['nope', '[]', '{"jsonrpc":"1.0","method":"ping","id":1}', '{"jsonrpc":"2.0","id":1}']) {
      const parsed = parseJsonRpc(raw);
      expect(isReply(parsed) && parsed.status).toBe(400);
    }
  });
});
