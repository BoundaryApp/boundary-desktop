import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearParkedApprovals,
  filterApprovalChoices,
  isHermesApprovalChoice,
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

  it('isHermesApprovalChoice accepts once/session/always/deny', () => {
    expect(isHermesApprovalChoice('once')).toBe(true);
    expect(isHermesApprovalChoice('deny')).toBe(true);
    expect(isHermesApprovalChoice('maybe')).toBe(false);
  });

  it('hides always when allow_permanent is false', () => {
    expect(
      filterApprovalChoices(['once', 'session', 'always', 'deny'], {
        allowPermanent: false,
      })
    ).toEqual(['once', 'session', 'deny']);
  });

  it('hides session when allow_session is false', () => {
    expect(
      filterApprovalChoices(['once', 'session', 'always', 'deny'], {
        allowSession: false,
      })
    ).toEqual(['once', 'always', 'deny']);
  });

  it('parks an approval and answers once without dropping the request', () => {
    const request = makeRequest();
    const event = parkApprovalRequest(request);
    expect(event).not.toBeNull();
    expect(event?.approvalRequestId).toBe('apr-1');
    expect(event?.choices).toContain('once');

    const result = respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'once',
    });
    expect(result.success).toBe(true);
    expect(request.responded).toEqual([{ choice: 'once' }]);
    expect(request.failed).toEqual([]);
  });

  it('answers deny', () => {
    const request = makeRequest();
    parkApprovalRequest(request);
    const result = respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'deny',
    });
    expect(result.success).toBe(true);
    expect(request.responded).toEqual([{ choice: 'deny' }]);
  });

  it('rejects always when not offered', () => {
    const request = makeRequest({
      params: {
        session_id: 'sess-1',
        request_id: 'apr-1',
        choices: ['once', 'deny'],
        allow_permanent: false,
      },
    });
    parkApprovalRequest(request);
    const result = respondToParkedApproval({
      rpcRequestId: 'rpc-1',
      choice: 'always',
    });
    expect(result.success).toBe(false);
    expect(request.responded).toEqual([]);
  });

  it('ignores non-approval methods', () => {
    const request = makeRequest({ method: 'clarify' });
    expect(parkApprovalRequest(request)).toBeNull();
  });

  it('defaults smart-denied prompts to once and deny', () => {
    expect(
      filterApprovalChoices(undefined, { smartDenied: true })
    ).toEqual(['once', 'deny']);
  });

  it('parks smart_denied from the gateway payload', () => {
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

  it('keeps the MCP call behind an untrusted-server approval', () => {
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

  it('drops a malformed mcp block', () => {
    expect(parseApprovalMcp({ server: 'calendar-personal' })).toBeUndefined();
    expect(parseApprovalMcp('calendar-personal')).toBeUndefined();
    expect(parseApprovalMcp({ server: 's', tool: 't', arguments: ['x'], tool_call_id: null })).toEqual({
      server: 's',
      tool: 't',
      arguments: null,
    });
  });
});
