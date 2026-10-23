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

  it('returns null when no draft exists', () => {
    const result = getProviderFormDraft('cerebrium');
    expect(result.success).toBe(true);
    expect(result.draft).toBeNull();
  });

  it('saves and restores sensitive values via safeStorage', () => {
    const save = saveProviderFormDraft({
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

    const loaded = getProviderFormDraft('cerebrium');
    expect(loaded.success).toBe(true);
    const values = loaded.draft!.values;
    expect(loaded.draft!.selectedModelId).toBe('Qwen/Qwen3-32B');
    expect(values.cerebrium_project_id).toBe('p-test');
    // The renderer never gets the secret back, only a token main can resolve.
    expect(JSON.stringify(values)).not.toContain('sat-secret');
    expect(JSON.stringify(values)).not.toContain('hf-secret');
    expect(isStoredSecretToken(values.hf_token)).toBe(true);
    expect(resolveStoredDraftSecrets('cerebrium', values)).toEqual({
      cerebrium_service_account_token: 'sat-secret',
      cerebrium_project_id: 'p-test',
      hf_token: 'hf-secret',
    });
  });

  it('keeps the stored secret when the renderer saves the token back unchanged', () => {
    saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: 'bt-key' },
      sensitiveNames: ['baseten_api_key'],
    });
    const token = getProviderFormDraft('baseten').draft!.values.baseten_api_key as string;
    saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: token },
      sensitiveNames: ['baseten_api_key'],
    });
    expect(resolveStoredDraftSecret('baseten', token)).toBe('bt-key');
  });

  it('resolves an unknown token to an empty string, and leaves plain values alone', () => {
    expect(resolveStoredDraftSecret('baseten', 'boundary-stored-secret:nope:**')).toBe('');
    expect(resolveStoredDraftSecret('baseten', 'typed-key')).toBe('typed-key');
  });

  it('clears a single provider draft', () => {
    saveProviderFormDraft({
      providerId: 'baseten',
      values: { baseten_api_key: 'bt-key' },
      sensitiveNames: ['baseten_api_key'],
    });
    saveProviderFormDraft({
      providerId: 'cerebrium',
      values: { cerebrium_project_id: 'p-1' },
      sensitiveNames: [],
    });

    clearProviderFormDraft('baseten');

    expect(getProviderFormDraft('baseten').draft).toBeNull();
    expect(getProviderFormDraft('cerebrium').draft?.values.cerebrium_project_id).toBe('p-1');
  });
});
