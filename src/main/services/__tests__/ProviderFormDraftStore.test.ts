import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProviderFormDraft,
  getProviderFormDraft,
  resolveStoredDraftSecret,
  resolveStoredDraftSecrets,
  saveProviderFormDraft,
} from '../onboarding/ProviderFormDraftStore';
import { isStoredSecretToken } from '../../../shared/utils/storedSecretToken';

describe('ProviderFormDraftStore', () => {
  beforeEach(() => {
    clearProviderFormDraft();
  });

  it('returns null when no draft exists', async () => {
    const result = await getProviderFormDraft('cerebrium');
    expect(result.success).toBe(true);
    expect(result.draft).toBeNull();
  });

  it('saves and restores sensitive values via safeStorage', async () => {
    const save = await saveProviderFormDraft({
      providerId: 'cerebrium',
      values: {
        cerebrium_service_account_token: 'sat-secret',
        cerebrium_project_id: 'p-test',
        hf_token: 'hf-secret',
      },
      sensitiveNames: ['cerebrium_service_account_token', 'hf_token'],
      selectedModelId: 'Qwen/Qwen3-32B',
    });

    expect(save.success).toBe(true);

    const loaded = await getProviderFormDraft('cerebrium');
    expect(loaded.success).toBe(true);
    const values = loaded.draft!.values;
    expect(loaded.draft!.selectedModelId).toBe('Qwen/Qwen3-32B');
    expect(values.cerebrium_project_id).toBe('p-test');
    // The renderer never gets the secret back, only a token main can resolve.
    expect(JSON.stringify(values)).not.toContain('sat-secret');
    expect(JSON.stringify(values)).not.toContain('hf-secret');
    expect(isStoredSecretToken(values.hf_token)).toBe(true);
    expect(await resolveStoredDraftSecrets('cerebrium', values)).toEqual({
      cerebrium_service_account_token: 'sat-secret',
      cerebrium_project_id: 'p-test',
      hf_token: 'hf-secret',
    });
  });

  it('keeps the stored secret when the renderer saves the token back unchanged', async () => {
    await saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: 'bt-key' },
      sensitiveNames: ['baseten_api_key'],
    });
    const token = (await getProviderFormDraft('baseten')).draft!.values.baseten_api_key as string;
    await saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: token },
      sensitiveNames: ['baseten_api_key'],
    });
    expect(await resolveStoredDraftSecret('baseten', token)).toBe('bt-key');
  });

  it('resolves an unknown token to an empty string, and leaves plain values alone', async () => {
    expect(await resolveStoredDraftSecret('baseten', 'boundary-stored-secret:nope:**')).toBe('');
    expect(await resolveStoredDraftSecret('baseten', 'typed-key')).toBe('typed-key');
  });

  it('clears a single provider draft', async () => {
    await saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: 'bt-key' },
      sensitiveNames: ['baseten_api_key'],
    });
    await saveProviderFormDraft({
      providerId: 'cerebrium',
      values: { cerebrium_project_id: 'p-1' },
      sensitiveNames: [],
    });

    clearProviderFormDraft('baseten');

    expect((await getProviderFormDraft('baseten')).draft).toBeNull();
    expect((await getProviderFormDraft('cerebrium')).draft?.values.cerebrium_project_id).toBe('p-1');
  });
});
