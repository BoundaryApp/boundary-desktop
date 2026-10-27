import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearParkedApprovals,
  filterApprovalChoices,
  isHermesApprovalChoice,
  listParkedApprovals,
  parkApprovalRequest,
  parseApprovalMcp,
  respondToParkedApproval,
} from '../hermesApprovals';
import type { ServerRequest } from '../vendor/json-rpc-channel';

function makeRequest(
  overrides: Partial<ServerRequest> & { params?: Record<string, unknown> } = {}
): ServerRequest & { responded: unknown[]; failed: unknown[] } {
  const responded: unknown[] = [];
  const failed: unknown[] = [];
  const request = {
    id: overrides.id ?? 'rpc-1',
    method: overrides.method ?? 'approval',
    params: overrides.params ?? {
      session_id: 'sess-1',
      request_id: 'apr-1',
      command: 'rm -rf /',
      description: 'Delete everything',
      choices: ['once', 'session', 'always', 'deny'],
      allow_session: true,
      allow_permanent: true,
    },
    replayed: overrides.replayed,
    respond: (result: Record<string, unknown>) => {
      responded.push(result);
    },
    fail: (code: number, message: string) => {
      failed.push({ code, message });
    },
  };
  return Object.assign(request, { responded, failed });
}

describe('hermesApprovals', () => {
  beforeEach(() => {
    clearParkedApprovals();
  });

  it('isHermesApprovalChoice accepts once/session/always/deny', async () => {
    expect(isHermesApprovalChoice('once')).toBe(true);
    expect(isHermesApprovalChoice('deny')).toBe(true);
    expect(isHermesApprovalChoice('maybe')).toBe(false);
  });

  it('hides always when allow_permanent is false', async () => {
    expect(
      filterApprovalChoices(['once', 'session', 'always', 'deny'], {
        allowPermanent: false,
      })
    ).toEqual(['once', 'session', 'deny']);
  });

  it('hides session when allow_session is false', async () => {
    expect(
      filterApprovalChoices(['once', 'session', 'always', 'deny'], {
        allowSession: false,
      })
    ).toEqual(['once', 'always', 'deny']);
  });

  it('parks an approval and answers once without dropping the request', async () => {
    const request = makeRequest();
    const event = parkApprovalRequest(request);
    expect(event).not.toBeNull();
    expect(event?.approvalRequestId).toBe('apr-1');
    expect(event?.choices).toContain('once');

    const result = await respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'once',
    });
    expect(result.success).toBe(true);
    expect(request.responded).toEqual([{ choice: 'once' }]);
    expect(request.failed).toEqual([]);
  });

  it('answers deny', async () => {
    const request = makeRequest();
    parkApprovalRequest(request);
    const result = await respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'deny',
    });
    expect(result.success).toBe(true);
    expect(request.responded).toEqual([{ choice: 'deny' }]);
  });

  it('rejects always when not offered', async () => {
    const request = makeRequest({
      params: {
        session_id: 'sess-1',
        request_id: 'apr-1',
        choices: ['once', 'deny'],
        allow_permanent: false,
      },
    });
    parkApprovalRequest(request);
    const result = await respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'always',
    });
    expect(result.success).toBe(false);
    expect(request.responded).toEqual([]);
  });

  it('parks one approval once when a replay repeats a live request', async () => {
    const live = makeRequest();
    parkApprovalRequest(live);
    const replayed = parkApprovalRequest(makeRequest({ id: 'pending:apr-1', replayed: true }));
    expect(replayed?.rpcRequestId).toBe('rpc-1');
    expect(listParkedApprovals().map((a) => a.rpcRequestId)).toEqual(['rpc-1']);
  });

  it('keeps an approval parked and reports failure when its answer cannot be sent', async () => {
    parkApprovalRequest(makeRequest(), async () => {
      throw new Error('no such approval');
    });
    expect(await respondToParkedApproval({ rpcRequestId: 'rpc-1', choice: 'once' })).toEqual({
      success: false,
      error: 'no such approval',
    });
    expect(listParkedApprovals()).toHaveLength(1);
  });

  it('ignores non-approval methods', async () => {
    const request = makeRequest({ method: 'clarify' });
    expect(parkApprovalRequest(request)).toBeNull();
  });

  it('defaults smart-denied prompts to once and deny', async () => {
    expect(
      filterApprovalChoices(undefined, { smartDenied: true })
    ).toEqual(['once', 'deny']);
  });

  it('parks smart_denied from the gateway payload', async () => {
    const request = makeRequest({
      params: {
        session_id: 'sess-1',
        request_id: 'apr-1',
        smart_denied: true,
      },
    });
    const event = parkApprovalRequest(request);
    expect(event?.smartDenied).toBe(true);
    expect(event?.choices).toEqual(['once', 'deny']);
  });

  it('keeps the MCP call behind an untrusted-server approval', async () => {
    const event = parkApprovalRequest(
      makeRequest({
        params: {
          session_id: 'sess-1',
          request_id: 'apr-1',
          choices: ['once', 'deny'],
          mcp: {
            server: 'calendar-personal',
            tool: 'caldav_create_event',
            arguments: { summary: 'Call with Jordan', start: '2026-10-23T11:00:00' },
            tool_call_id: 'call_1',
          },
        },
      })
    );
    expect(event?.mcp).toEqual({
      server: 'calendar-personal',
      tool: 'caldav_create_event',
      arguments: { summary: 'Call with Jordan', start: '2026-10-23T11:00:00' },
      toolCallId: 'call_1',
    });
    expect(event?.choices).toEqual(['once', 'deny']);
  });

  it('drops a malformed mcp block', async () => {
    expect(parseApprovalMcp({ server: 'calendar-personal' })).toBeUndefined();
    expect(parseApprovalMcp('calendar-personal')).toBeUndefined();
    expect(parseApprovalMcp({ server: 's', tool: 't', arguments: ['x'], tool_call_id: null })).toEqual({
      server: 's',
      tool: 't',
      arguments: null,
    });
  });
});
