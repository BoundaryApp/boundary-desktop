import { describe, it, expect } from 'vitest';
import {
  basetenOpenAiBaseUrl,
  buildBasetenTrussEnv,
  parseTrussPushJson,
  parseTrussPushLogsFallback,
} from '../infrastructure/TrussRunner';

describe('TrussRunner parsers', () => {
  it('parseTrussPushJson reads model and deployment ids', () => {
    const json = JSON.stringify({
      model_id: 'abc12def',
      deployment_id: 'xyz99',
    });
    expect(parseTrussPushJson(json)).toEqual({
      modelId: 'abc12def',
      deploymentId: 'xyz99',
    });
  });

  it('parseTrussPushLogsFallback extracts ids from log URL', () => {
    const text =
      'View logs at https://app.baseten.co/models/abc12def/logs/xyz99\n';
    expect(parseTrussPushLogsFallback(text)).toEqual({
      modelId: 'abc12def',
      deploymentId: 'xyz99',
    });
  });

  it('basetenOpenAiBaseUrl builds production sync v1 path', () => {
    expect(basetenOpenAiBaseUrl('abc12def')).toBe(
      'https://model-abc12def.api.baseten.co/environments/production/sync/v1'
    );
  });

  it('buildBasetenTrussEnv sets Baseten remote and token env vars', () => {
    const env = buildBasetenTrussEnv('bt-key', 'hf-key');
    expect(env.BASETEN_API_KEY).toBe('bt-key');
    expect(env.HF_ACCESS_TOKEN).toBe('hf-key');
    expect(env.BASETEN_TRUSS_AUTH_KEYRING_DISABLED).toBe('1');
    expect(env.USER_TRUSSRC_PATH).toContain('tools/truss/.trussrc');
  });
});
