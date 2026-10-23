import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  deleteBasetenModel,
  fetchBasetenProductionDeployment,
  getBasetenDeployment,
  getBasetenModel,
  listBasetenModels,
  parseBasetenModelsResponse,
  upsertBasetenSecret,
  validateBasetenApiKey,
} from '../infrastructure/BasetenApiClient';

describe('BasetenApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok when API responds 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      })
    );
    const result = await validateBasetenApiKey('test-key');
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.baseten.co/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Api-Key test-key' }),
      })
    );
  });

  it('returns error when API responds 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      })
    );
    const result = await validateBasetenApiKey('bad-key');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('upsertBasetenSecret posts name and value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      })
    );
    const result = await upsertBasetenSecret('test-key', 'hf_access_token', 'hf_abc');
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.baseten.co/v1/secrets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'hf_access_token', value: 'hf_abc' }),
      })
    );
  });

  it('parses wrapped Baseten model list responses', () => {
    const models = parseBasetenModelsResponse({
      models: [
        {
          id: 'model-abc',
          name: 'Existing Llama',
          production_deployment_id: 'dep-prod',
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'model-abc',
        displayName: 'Existing Llama',
        productionDeploymentId: 'dep-prod',
        createdAt: undefined,
      },
    ]);
  });

  it('listBasetenModels fetches and parses candidates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ model_id: 'model-abc', display_name: 'Existing Llama' }],
        }),
      })
    );

    const result = await listBasetenModels('test-key');

    expect(result.ok).toBe(true);
    expect(result.models[0]).toMatchObject({
      id: 'model-abc',
      displayName: 'Existing Llama',
    });
  });

  it('getBasetenModel returns production deployment id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'model-abc',
          production_deployment_id: 'dep-prod',
        }),
      })
    );
    const result = await getBasetenModel('key', 'model-abc');
    expect(result.ok).toBe(true);
    expect(result.model?.productionDeploymentId).toBe('dep-prod');
  });

  it('getBasetenDeployment parses status and replica count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: 'dep-prod',
          status: 'SCALED_TO_ZERO',
          active_replica_count: 0,
          is_production: true,
        }),
      })
    );
    const result = await getBasetenDeployment('key', 'model-abc', 'dep-prod');
    expect(result.ok).toBe(true);
    expect(result.deployment?.status).toBe('SCALED_TO_ZERO');
    expect(result.deployment?.activeReplicaCount).toBe(0);
  });

  it('fetchBasetenProductionDeployment resolves deployment id from model', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'model-abc',
            production_deployment_id: 'dep-prod',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'dep-prod',
            status: 'SCALED_TO_ZERO',
            active_replica_count: 0,
            is_production: true,
          }),
        })
    );
    const result = await fetchBasetenProductionDeployment('key', 'model-abc');
    expect(result.deployment?.status).toBe('SCALED_TO_ZERO');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('deleteBasetenModel treats 404 as success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '',
      })
    );
    const result = await deleteBasetenModel('key', 'model-abc');
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.baseten.co/v1/models/model-abc',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});
