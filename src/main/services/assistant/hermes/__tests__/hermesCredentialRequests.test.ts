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

  it('parks a secret request without any value in the event', async () => {
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

  it('rejects requests it cannot show', async () => {
    expect(parkCredentialRequest(request('secret', { session_id: 's1' }).req)).toBeNull();
    expect(parkCredentialRequest(request('vault.save_login', { session_id: 's1' }).req)).toBeNull();
    expect(parkCredentialRequest(request('approval', { session_id: 's1' }).req)).toBeNull();
  });

  it('answers with the value and forgets the request', async () => {
    const { req, respond } = request('secret', { session_id: 's1', env_var: 'X' });
    parkCredentialRequest(req);
    expect(await respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: 'sk-1' })).toEqual({
      success: true,
    });
    expect(respond).toHaveBeenCalledWith({ value: 'sk-1' });
    expect(listParkedCredentialRequests()).toEqual([]);
  });

  it('answers a skip with an empty value', async () => {
    const { req, respond } = request('vault.code', { session_id: 's1', site: 'x.com' });
    parkCredentialRequest(req);
    await respondToCredentialRequest({ rpcRequestId: 'rpc-1' });
    expect(respond).toHaveBeenCalledWith({ value: '' });
  });

  it('sends a saved login as the JSON Hermes expects', async () => {
    const { req, respond } = request('vault.save_login', {
      session_id: 's1',
      origin: 'https://x.com',
      site: 'x.com',
    });
    parkCredentialRequest(req);
    await respondToCredentialRequest({
      rpcRequestId: 'rpc-1',
      login: { identifier: 'me@x.com', password: 'pw' },
    });
    expect(JSON.parse(respond.mock.calls[0][0].value)).toEqual({
      identifier: 'me@x.com',
      password: 'pw',
    });
  });

  describe('vault.create_login', () => {
    const params = {
      session_id: 's1',
      origin: 'https://app.example.com',
      site: 'app.example.com',
      identifier: 'me@example.com',
      regenerate: false,
    };

    it('parks the request with the site and identifier', () => {
      expect(parkCredentialRequest(request('vault.create_login', params).req)).toEqual({
        rpcRequestId: 'rpc-1',
        sessionId: 's1',
        kind: 'vault.create_login',
        origin: 'https://app.example.com',
        site: 'app.example.com',
        identifier: 'me@example.com',
        regenerate: false,
        replayed: false,
      });
      expect(
        parkCredentialRequest(request('vault.create_login', { ...params, regenerate: true }, 'rpc-2').req)
          ?.regenerate
      ).toBe(true);
    });

    it('refuses a request with no origin', () => {
      expect(parkCredentialRequest(request('vault.create_login', { session_id: 's1' }).req)).toBeNull();
    });

    it('approves a generated password with {"generate": true}', async () => {
      const { req, respond } = request('vault.create_login', params);
      parkCredentialRequest(req);
      expect(
        await respondToCredentialRequest({ rpcRequestId: 'rpc-1', createLogin: { generate: true } })
      ).toEqual({ success: true });
      expect(JSON.parse(respond.mock.calls[0][0].value)).toEqual({ generate: true });
      expect(listParkedCredentialRequests()).toEqual([]);
    });

    it('sends a typed password as {"password": ...}', async () => {
      const { req, respond } = request('vault.create_login', params);
      parkCredentialRequest(req);
      await respondToCredentialRequest({ rpcRequestId: 'rpc-1', createLogin: { password: 'pw-1' } });
      expect(JSON.parse(respond.mock.calls[0][0].value)).toEqual({ password: 'pw-1' });
    });

    it('declines with an empty value', async () => {
      const { req, respond } = request('vault.create_login', params);
      parkCredentialRequest(req);
      await respondToCredentialRequest({ rpcRequestId: 'rpc-1' });
      expect(respond).toHaveBeenCalledWith({ value: '' });
    });

    it('keeps the request open for an empty typed password', async () => {
      const { req, respond } = request('vault.create_login', params);
      parkCredentialRequest(req);
      const res = await respondToCredentialRequest({ rpcRequestId: 'rpc-1', createLogin: { password: '' } });
      expect(res.success).toBe(false);
      expect(respond).not.toHaveBeenCalled();
      expect(listParkedCredentialRequests()).toHaveLength(1);
    });
  });

  describe('vault.capture_secret', () => {
    const params = {
      session_id: 's1',
      origin: 'https://dash.example.com',
      site: 'dash.example.com',
      name: 'EXAMPLE_API_KEY',
      destination: 'env',
      last4: 'a1b2',
      replaces: false,
      capture_id: '',
    };

    it('parks the request with the name, destination and last four, and no value', () => {
      expect(parkCredentialRequest(request('vault.capture_secret', params).req)).toEqual({
        rpcRequestId: 'rpc-1',
        sessionId: 's1',
        kind: 'vault.capture_secret',
        origin: 'https://dash.example.com',
        site: 'dash.example.com',
        name: 'EXAMPLE_API_KEY',
        destination: 'env',
        last4: 'a1b2',
        replaces: false,
        replayed: false,
      });
    });

    it('refuses a request with no name or an unknown destination', () => {
      expect(parkCredentialRequest(request('vault.capture_secret', { ...params, name: '' }).req)).toBeNull();
      expect(
        parkCredentialRequest(request('vault.capture_secret', { ...params, destination: 'disk' }).req)
      ).toBeNull();
    });

    it('approves an env capture with "approve"', async () => {
      const { req, respond } = request('vault.capture_secret', params);
      parkCredentialRequest(req);
      expect(await respondToCredentialRequest({ rpcRequestId: 'rpc-1', approve: true })).toEqual({
        success: true,
      });
      expect(respond).toHaveBeenCalledWith({ value: 'approve' });
    });

    it('declines with an empty value', async () => {
      const { req, respond } = request('vault.capture_secret', params);
      parkCredentialRequest(req);
      await respondToCredentialRequest({ rpcRequestId: 'rpc-1' });
      expect(respond).toHaveBeenCalledWith({ value: '' });
    });

    it('never approves a viewer capture, and keeps it open for a decline', async () => {
      const { req, respond } = request('vault.capture_secret', {
        ...params,
        destination: 'viewer',
        capture_id: 'capture_1',
      });
      parkCredentialRequest(req);
      const res = await respondToCredentialRequest({ rpcRequestId: 'rpc-1', approve: true });
      expect(res.success).toBe(false);
      expect(respond).not.toHaveBeenCalled();
      await respondToCredentialRequest({ rpcRequestId: 'rpc-1' });
      expect(respond).toHaveBeenCalledWith({ value: '' });
    });
  });

  it('keeps the request open when the answer is invalid', async () => {
    const { req, respond } = request('secret', { session_id: 's1', env_var: 'X' });
    parkCredentialRequest(req);
    expect((await respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: '' })).success).toBe(false);
    expect(
      (await respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: 'x'.repeat(16 * 1024 + 1) })).success
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
    expect(listParkedCredentialRequests()).toHaveLength(1);
  });

  it('keeps the request and reports failure when the answer cannot be sent', async () => {
    const req: ServerRequest = { id: 'rpc-1', method: 'secret', params: { session_id: 's1', env_var: 'X' }, respond: vi.fn(), fail: vi.fn() };
    parkCredentialRequest(req, () => {
      throw new Error('socket gone');
    });
    expect(await respondToCredentialRequest({ rpcRequestId: 'rpc-1', value: 'v' })).toEqual({
      success: false,
      error: 'socket gone',
    });
    expect(listParkedCredentialRequests()).toHaveLength(1);
  });

  it('refuses an unknown request id as not pending', async () => {
    const result = await respondToCredentialRequest({ rpcRequestId: 'nope', value: 'v' });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('not-pending');
  });
});
