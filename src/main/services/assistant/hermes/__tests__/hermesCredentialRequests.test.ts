import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerRequest } from '../vendor/json-rpc-channel';
import {
  clearParkedCredentialRequests,
  listParkedCredentialRequests,
  parkCredentialRequest,
  respondToCredentialRequest,
} from '../hermesCredentialRequests';

function request(method: string, params: Record<string, unknown>, id = 'rpc-1') {
  const respond = vi.fn();
  const req: ServerRequest = { id, method, params, respond, fail: vi.fn() };
  return { req, respond };
}

describe('hermesCredentialRequests', () => {
  afterEach(() => clearParkedCredentialRequests());

  it('parks a secret request without any value in the event', () => {
    const { req } = request('secret', {
      session_id: 's1',
      env_var: 'GITHUB_TOKEN',
      prompt: 'Needed to open PRs',
    });
    expect(parkCredentialRequest(req)).toEqual({
      rpcRequestId: 'rpc-1',
      sessionId: 's1',
      kind: 'secret',
      envVar: 'GITHUB_TOKEN',
      prompt: 'Needed to open PRs',
      replayed: false,
    });
  });

  it('rejects requests it cannot show', () => {
    expect(parkCredentialRequest(request('secret', { session_id: 's1' }).req)).toBeNull();
    expect(parkCredentialRequest(request('vault.save_login', { session_id: 's1' }).req)).toBeNull();
    expect(parkCredentialRequest(request('approval', { session_id: 's1' }).req)).toBeNull();
  });

  it('answers with the value and forgets the request', () => {
    const { req, respond } = request('secret', { session_id: 's1', env_var: 'X' });
    parkCredentialRequest(req);
    expect(respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: 'sk-1' })).toEqual({
      success: true,
    });
    expect(respond).toHaveBeenCalledWith({ value: 'sk-1' });
    expect(listParkedCredentialRequests()).toEqual([]);
  });

  it('answers a skip with an empty value', () => {
    const { req, respond } = request('vault.code', { session_id: 's1', site: 'x.com' });
    parkCredentialRequest(req);
    respondToCredentialRequest({ rpcRequestId: 'rpc-1' });
    expect(respond).toHaveBeenCalledWith({ value: '' });
  });

  it('sends a saved login as the JSON Hermes expects', () => {
    const { req, respond } = request('vault.save_login', {
      session_id: 's1',
      origin: 'https://x.com',
      site: 'x.com',
    });
    parkCredentialRequest(req);
    respondToCredentialRequest({
      rpcRequestId: 'rpc-1',
      login: { identifier: 'me@x.com', password: 'pw' },
    });
    expect(JSON.parse(respond.mock.calls[0][0].value)).toEqual({
      identifier: 'me@x.com',
      password: 'pw',
    });
  });

  it('keeps the request open when the answer is invalid', () => {
    const { req, respond } = request('secret', { session_id: 's1', env_var: 'X' });
    parkCredentialRequest(req);
    expect(respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: '' }).success).toBe(false);
    expect(
      respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: 'x'.repeat(16 * 1024 + 1) }).success
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(listParkedCredentialRequests()).toHaveLength(1);
  });

  it('refuses an unknown request id', () => {
    expect(respondToCredentialRequest({ rpcRequestId: 'nope', value: 'v' }).success).toBe(false);
  });
});
