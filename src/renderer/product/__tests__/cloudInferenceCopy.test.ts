import { describe, expect, it } from 'vitest';
import { emptyInferenceProvidersStatus } from '../../../shared/types/onboarding';
import { appCloudProvider, cloudInferenceNotice } from '../cloudInferenceCopy';

describe('appCloudProvider', () => {
  const status = emptyInferenceProvidersStatus();

  it('names who the app default sends to, and nobody for Local', () => {
    expect(appCloudProvider({ ...status, appDefault: 'openrouter' })).toBe('OpenRouter');
    expect(appCloudProvider({ ...status, appDefault: 'local' })).toBeNull();
    expect(appCloudProvider(null)).toBeNull();
  });

  it('says a confidential provider, not a Circle member, for a pool first', () => {
    const pool = appCloudProvider({ ...status, appSharedModel: { slot: 'confidential', modelId: 'qwen' } });
    expect(pool).toBe('a confidential provider');
    expect(cloudInferenceNotice(pool!)).toBe(
      'A confidential provider you added runs your model. Your messages, and any files, memories or calendar data the agent reads, go to that provider.'
    );
    const peer = appCloudProvider({
      ...status,
      appSharedModel: { slot: 'peer', modelId: 'qwen3', peer: { circleId: 'c', providerId: 'p' } },
    });
    expect(cloudInferenceNotice(peer!)).toMatch(/^A Circle member’s Mac runs your model/);
  });
});
