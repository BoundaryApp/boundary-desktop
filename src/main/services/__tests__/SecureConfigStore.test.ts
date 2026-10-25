import Store from 'electron-store';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPublicConfig,
  clearSecureConfig,
  getSecureConfigValue,
  hasRequiredSecureConfig,
  migrateLegacyConfigSecrets,
  setSecureConfigValue,
} from '../config/SecureConfigStore';

describe('SecureConfigStore', () => {
  let legacyStore: Store<Record<string, unknown>>;

  beforeEach(() => {
    clearSecureConfig();
    legacyStore = new Store<Record<string, unknown>>({
      name: `legacy-config-${Date.now()}`,
      defaults: {
        webhookUrl: '',
        registryUrl: 'http://localhost:3001',
      },
    });
  });

  it('migrates plaintext sensitive config into encrypted storage', async () => {
    legacyStore.set('apiKey', 'api-secret-value');
    legacyStore.set('secretToken', 'sk-secret-token');
    legacyStore.set('databaseUrl', 'postgresql://user:pass@example.test/db');

    await migrateLegacyConfigSecrets(legacyStore);
    const config = await buildPublicConfig(legacyStore);

    expect(config.apiKey).toEqual({ configured: true, preview: 'api-********alue' });
    expect(config.secretToken).toEqual({ configured: true, preview: 'sk-s*******oken' });
    expect(config.databaseUrl.configured).toBe(true);
    expect(JSON.stringify(config)).not.toContain('api-secret-value');
    expect(JSON.stringify(config)).not.toContain('sk-secret-token');
    expect(legacyStore.get('apiKey')).toBeUndefined();
    expect(await getSecureConfigValue('apiKey')).toBe('api-secret-value');
    expect(await hasRequiredSecureConfig()).toBe(true);
  });

  it('preserves existing encrypted values when blank values are saved', async () => {
    await setSecureConfigValue('apiKey', 'api-secret-value');
    await setSecureConfigValue('apiKey', '');

    expect(await getSecureConfigValue('apiKey')).toBe('api-secret-value');
  });
});

