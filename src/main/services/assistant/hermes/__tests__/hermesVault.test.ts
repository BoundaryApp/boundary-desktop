import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcGatewayError } from '../vendor/json-rpc-channel';

const requestVault = vi.fn();
vi.mock('../hermesGatewaySession', () => ({
  getHermesGatewaySession: () => ({
    requestVault: (...args: unknown[]) => requestVault(...args),
  }),
}));
vi.mock('../hermesAgents', () => ({
  resolveProfileForAgent: (slug: string) => (slug === 'assistant' ? null : slug),
}));

import {
  addVaultLogin,
  listVaultLogins,
  listVaultSources,
  normalizeLoginOrigin,
  removeVaultLogin,
  replaceVaultLoginPassword,
  unlockVaultSource,
} from '../hermesVault';

const linkedin = {
  id: 'v_1',
  kind: 'login',
  label: 'LinkedIn',
  origin: 'https://www.linkedin.com',
  created_at: '2026-10-06T13:00:00Z',
  identifier: 'sam@example.com',
  identifier_type: 'email',
  backend: 'local',
};

beforeEach(() => {
  requestVault.mockReset();
});

describe('hermesVault', () => {
  it('lists logins for the built-in agent without a profile, and skips cards', async () => {
    requestVault.mockResolvedValue({
      items: [linkedin, { id: 'v_2', kind: 'payment', label: 'Visa', backend: 'local' }],
    });
    const result = await listVaultLogins({ agentSlug: 'assistant' });
    expect(requestVault).toHaveBeenCalledWith('vault.list', {});
    expect(result).toEqual({
      success: true,
      logins: [
        {
          id: 'v_1',
          label: 'LinkedIn',
          origin: 'https://www.linkedin.com',
          identifier: 'sam@example.com',
          identifierType: 'email',
          createdAt: '2026-10-06T13:00:00Z',
          backend: 'local',
        },
      ],
    });
  });

  it('scopes calls to the agent profile', async () => {
    requestVault.mockResolvedValue({ sources: [] });
    await listVaultSources({ agentSlug: 'researcher' });
    expect(requestVault).toHaveBeenCalledWith('vault.sources', { profile: 'researcher' });
  });

  it('refuses an agent slug that is not one', async () => {
    const result = await listVaultLogins({ agentSlug: '../default' });
    expect(result.success).toBe(false);
    expect(requestVault).not.toHaveBeenCalled();
  });

  it('adds a login with the identifier and password in the secret payload', async () => {
    requestVault.mockResolvedValue({ id: 'v_9' });
    const result = await addVaultLogin({
      agentSlug: 'assistant',
      label: 'LinkedIn',
      origin: 'https://www.linkedin.com/login?x=1',
      identifierType: 'email',
      identifier: ' sam@example.com ',
      password: 'hunter2',
    });
    expect(result).toEqual({ success: true, id: 'v_9' });
    expect(requestVault).toHaveBeenCalledWith('vault.add', {
      kind: 'login',
      label: 'LinkedIn',
      origin: 'https://www.linkedin.com',
      secret: { identifier_type: 'email', identifier: 'sam@example.com', password: 'hunter2' },
    });
  });

  it('never echoes the password in an error', async () => {
    requestVault.mockRejectedValue(new JsonRpcGatewayError('bad value hunter2 for origin', { code: 5095 }));
    const result = await addVaultLogin({
      agentSlug: 'assistant',
      label: 'X',
      origin: 'https://x.com',
      identifierType: 'username',
      identifier: 'me',
      password: 'hunter2',
    });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('hunter2');
    expect(result.error).toContain('[REDACTED]');
  });

  it('validates before calling Hermes', async () => {
    const result = await addVaultLogin({
      agentSlug: 'assistant',
      label: 'X',
      origin: 'ftp://x.com',
      identifierType: 'username',
      identifier: 'me',
      password: 'pw',
    });
    expect(result.success).toBe(false);
    expect(requestVault).not.toHaveBeenCalled();
  });

  it('says plainly when Hermes has no vault', async () => {
    requestVault.mockRejectedValue(new JsonRpcGatewayError('Method not found', { code: -32601 }));
    const result = await listVaultLogins({ agentSlug: 'assistant' });
    expect(result.error).toMatch(/no password vault/);
  });

  it('replaces a password by adding first, then removing the old login', async () => {
    requestVault.mockImplementation(async (method: string) => {
      if (method === 'vault.list') return { items: [linkedin] };
      if (method === 'vault.add') return { id: 'v_new' };
      if (method === 'vault.remove') return { removed: true };
      throw new Error('unexpected');
    });
    const result = await replaceVaultLoginPassword({ agentSlug: 'assistant', id: 'v_1', password: 'new-pw' });
    expect(result).toEqual({ success: true, id: 'v_new' });
    expect(requestVault.mock.calls.map((c) => c[0])).toEqual(['vault.list', 'vault.add', 'vault.remove']);
    expect(requestVault.mock.calls[1][1]).toMatchObject({
      origin: 'https://www.linkedin.com',
      secret: { identifier: 'sam@example.com', identifier_type: 'email', password: 'new-pw' },
    });
  });

  it('keeps the old login when saving the new password fails', async () => {
    requestVault.mockImplementation(async (method: string) => {
      if (method === 'vault.list') return { items: [linkedin] };
      throw new JsonRpcGatewayError('store locked', { code: 5095 });
    });
    const result = await replaceVaultLoginPassword({ agentSlug: 'assistant', id: 'v_1', password: 'new-pw' });
    expect(result.success).toBe(false);
    expect(requestVault.mock.calls.map((c) => c[0])).not.toContain('vault.remove');
  });

  it('reports a login that was already gone', async () => {
    requestVault.mockResolvedValue({ removed: false });
    const result = await removeVaultLogin({ agentSlug: 'assistant', id: 'v_1' });
    expect(result.success).toBe(false);
  });

  it('scrubs the master password from unlock errors', async () => {
    requestVault.mockRejectedValue(new JsonRpcGatewayError('op said: s3cret is wrong', { code: 5095 }));
    const result = await unlockVaultSource({ agentSlug: 'assistant', name: '1password', password: 's3cret' });
    expect(result.error).not.toContain('s3cret');
  });

  it('reduces a URL to its origin', () => {
    expect(normalizeLoginOrigin('https://www.linkedin.com/in/someone')).toBe('https://www.linkedin.com');
    expect(normalizeLoginOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(() => normalizeLoginOrigin('linkedin.com')).toThrow();
  });
});
