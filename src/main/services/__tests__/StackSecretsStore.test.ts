import { describe, expect, it } from 'vitest';
import {
  deleteSecretsForInstance,
  getSecret,
  listConfiguredSecrets,
  setSecret,
} from '../infrastructure/StackSecretsStore';

describe('StackSecretsStore', () => {
  it('returns masked previews for configured secrets', async () => {
    await deleteSecretsForInstance('inst-preview');
    await setSecret('inst-preview', 'baseten_api_key', 'bt-secret-key');

    const previews = await listConfiguredSecrets('inst-preview', [
      'baseten_api_key',
      'hf_token',
    ]);

    expect(previews).toEqual({
      baseten_api_key: { configured: true, preview: 'bt-s*****-key' },
      hf_token: { configured: false },
    });
    expect(JSON.stringify(previews)).not.toContain('bt-secret-key');
    expect(await getSecret('inst-preview', 'baseten_api_key')).toBe('bt-secret-key');
  });
});

