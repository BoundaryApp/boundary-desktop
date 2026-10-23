import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cerebriumOpenAiBaseUrl,
  createCerebriumApiKey,
  deleteCerebriumApp,
  getCerebriumProjectSubscription,
  listCerebriumApps,
  parseCerebriumApiKeyResponse,
  parseCerebriumAppsResponse,
  parseCerebriumSubscriptionResponse,
  updateCerebriumProjectSecrets,
  validateCerebriumServiceAccount,
} from '../infrastructure/CerebriumApiClient';

describe('CerebriumApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses wrapped app list responses', () => {
    const apps = parseCerebriumAppsResponse({
      apps: [
        {
          app_id: 'app-1',
          app_name: 'boundary-qwen3-32b',
          status: 'ready',
        },
      ],
    });

    expect(apps).toEqual([
      {
        id: 'app-1',
        name: 'boundary-qwen3-32b',
        status: 'ready',
        createdAt: undefined,
      },
    ]);
  });

  it('validates service account by listing apps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      })
    );

    const result = await validateCerebriumServiceAccount('service-token', 'p-test');

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.cerebrium.ai/v2/projects/p-test/apps',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer service-token' }),
      })
    );
  });

  it('lists apps and maps names', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 'app-1', name: 'boundary-llama4-scout' }],
        }),
      })
    );

    const result = await listCerebriumApps('token', 'p-test');

    expect(result.ok).toBe(true);
    expect(result.apps[0]).toMatchObject({
      id: 'app-1',
      name: 'boundary-llama4-scout',
    });
  });

  it('updates project secrets without leaking values into URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      })
    );

    const result = await updateCerebriumProjectSecrets('token', 'p-test', {
      HF_TOKEN: 'hf-secret',
    });

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.cerebrium.ai/v2/projects/p-test/secrets',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secrets: { HF_TOKEN: 'hf-secret' } }),
      })
    );
  });

  it('extracts created API keys from nested responses', async () => {
    expect(parseCerebriumApiKeyResponse({ data: { api_key: 'jwt-token' } })).toBe('jwt-token');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ token: 'jwt-token' }),
      })
    );

    const result = await createCerebriumApiKey('token', 'p-test');

    expect(result.ok).toBe(true);
    expect(result.apiKey).toBe('jwt-token');
  });

  it('treats delete 404 as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '',
      })
    );

    const result = await deleteCerebriumApp('token', 'p-test', 'app-1');

    expect(result.ok).toBe(true);
  });

  it('builds OpenAI-compatible Cerebrium v1 base URL', () => {
    expect(
      cerebriumOpenAiBaseUrl({
        projectId: 'p-test',
        appName: 'boundary-qwen3-32b',
        region: 'aws.us-east-1',
      })
    ).toBe('https://api.aws.us-east-1.cerebrium.ai/v4/p-test/boundary-qwen3-32b/v1');
  });

  it('parses subscription responses including nested plan codes', () => {
    expect(
      parseCerebriumSubscriptionResponse({
        planCode: 'hobby',
        name: 'Hobby',
        status: 'active',
      })
    ).toMatchObject({ planCode: 'hobby', name: 'Hobby', status: 'active' });

    expect(
      parseCerebriumSubscriptionResponse({
        data: { plan_code: 'enterprise', max_cpu: 48 },
      })
    ).toMatchObject({ planCode: 'enterprise', maxCpu: 48 });
  });

  it('fetches project subscription', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ planCode: 'hobby', name: 'Hobby', status: 'active' }),
      })
    );

    const result = await getCerebriumProjectSubscription('token', 'p-test');

    expect(result.ok).toBe(true);
    expect(result.subscription?.planCode).toBe('hobby');
    expect(fetch).toHaveBeenCalledWith(
      'https://rest.cerebrium.ai/v2/projects/p-test/subscription',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      })
    );
  });
});
