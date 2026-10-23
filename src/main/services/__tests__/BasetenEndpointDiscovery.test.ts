import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverBasetenOpenAiEndpoints,
  listBasetenDeployments,
} from '../onboarding/BasetenEndpointDiscovery';

describe('BasetenEndpointDiscovery', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns verified OpenAI-compatible Baseten endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              {
                id: 'model-abc',
                name: 'Existing Llama',
                production_deployment_id: 'dep-prod',
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 'dep-prod',
            status: 'ACTIVE',
            active_replica_count: 1,
            is_production: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: 'ready' } }],
            }),
        })
    );

    const result = await discoverBasetenOpenAiEndpoints('bt-key');

    expect(result.success).toBe(true);
    expect(result.endpoints).toEqual([
      expect.objectContaining({
        providerId: 'baseten',
        displayName: 'Existing Llama',
        modelId: 'model-abc',
        deploymentId: 'dep-prod',
        endpointUrl: 'https://model-model-abc.api.baseten.co/environments/production/sync/v1',
        verified: true,
      }),
    ]);
  });

  it('filters out endpoints that do not return chat content', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ models: [{ id: 'model-abc' }] }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
        })
    );

    const result = await discoverBasetenOpenAiEndpoints('bt-key');

    expect(result.success).toBe(true);
    expect(result.endpoints).toEqual([]);
  });

  it('lists Baseten deployments without probing chat completions', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              id: 'model-abc',
              name: 'Existing Llama',
              production_deployment_id: 'dep-prod',
            },
          ],
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
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await listBasetenDeployments('bt-key');

    expect(result.success).toBe(true);
    expect(result.endpoints).toEqual([
      expect.objectContaining({
        providerId: 'baseten',
        displayName: 'Existing Llama',
        modelId: 'model-abc',
        deploymentId: 'dep-prod',
        healthStatus: 'SCALED_TO_ZERO',
        endpointUrl: 'https://model-model-abc.api.baseten.co/environments/production/sync/v1',
        verified: false,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
