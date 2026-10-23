import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pushLlmProxyUpstream, readLlmProxyAdminToken, readLlmProxyStatus } from '../llmProxyAdmin';

const view = {
  chat: { url: 'https://openrouter.ai/api/v1', api_key_set: true },
  lightrag: { url: 'https://openrouter.ai/api/v1', api_key_set: true },
  embed: { url: 'http://host.docker.internal:1234/v1', api_key_set: false },
};

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

describe('llmProxyAdmin', () => {
  it('pushes the chat and LightRAG routes with the bearer token', async () => {
    const fetchImpl = fakeFetch(200, view);
    const result = await pushLlmProxyUpstream(
      { adminPort: 14001, token: 'admin-token', fetchImpl: fetchImpl as unknown as typeof fetch },
      { url: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-secret' }
    );
    expect(result).toEqual({
      ok: true,
      status: {
        chat: { url: 'https://openrouter.ai/api/v1', apiKeySet: true },
        lightrag: { url: 'https://openrouter.ai/api/v1', apiKeySet: true },
        embed: { url: 'http://host.docker.internal:1234/v1', apiKeySet: false },
      },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:14001/admin/upstreams');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer admin-token');
    expect(JSON.parse(String(init.body))).toEqual({
      chat: { url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-secret' },
      lightrag: { url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-secret' },
    });
  });

  it('reads the restart marker and pushed flags from newer stacks', async () => {
    const route = { url: 'https://openrouter.ai/api/v1', api_key_set: true, pushed: true };
    const fetchImpl = fakeFetch(200, {
      chat: route,
      lightrag: route,
      embed: { url: '', api_key_set: false, pushed: false },
      proxy: { boot_id: '9f2c', started_at: 1791331200 },
    });
    const result = await readLlmProxyStatus({
      adminPort: 4001,
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: true,
      status: {
        chat: { url: 'https://openrouter.ai/api/v1', apiKeySet: true, pushed: true },
        lightrag: { url: 'https://openrouter.ai/api/v1', apiKeySet: true, pushed: true },
        embed: { url: '', apiKeySet: false, pushed: false },
        proxy: { bootId: '9f2c', startedAt: 1791331200 },
      },
    });
  });

  it('never echoes the key or token in an error', async () => {
    const fetchImpl = fakeFetch(500, 'boom sk-or-secret admin-token');
    const result = await pushLlmProxyUpstream(
      { adminPort: 4001, token: 'admin-token', fetchImpl: fetchImpl as unknown as typeof fetch },
      { url: 'https://x', apiKey: 'sk-or-secret' }
    );
    expect(result.ok).toBe(false);
    const error = 'error' in result ? result.error : '';
    expect(error).not.toContain('sk-or-secret');
    expect(error).not.toContain('admin-token');
  });

  it('reports an unreachable proxy', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4001');
    });
    const result = await readLlmProxyStatus({
      adminPort: 4001,
      token: 't',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect('error' in result ? result.error : '').toMatch(/unreachable/);
  });

  it('reads the admin token from the stack .env', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-token-'));
    expect(readLlmProxyAdminToken(root)).toBeNull();
    fs.writeFileSync(path.join(root, '.env'), 'OTHER=1\nLLM_PROXY_ADMIN_TOKEN=abc123\n');
    expect(readLlmProxyAdminToken(root)).toBe('abc123');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
