import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../assistant/stackEnv';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { ensureTwentySecrets } from '../twentySecrets';

const ENV = 'stack:.env';
const bytes = (fill: number) => (size: number) => Buffer.alloc(size, fill);

describe('ensureTwentySecrets', () => {
  it('writes both secrets when .env has neither, as setup.sh generates them', async () => {
    const files = createFakeStackFiles({ [ENV]: 'COMPOSE_PROFILES=core\nTWENTY_MCP_ENABLED=1\n' });

    expect(await ensureTwentySecrets(files, bytes(0xab))).toEqual(['TWENTY_ENCRYPTION_KEY', 'TWENTY_DB_PASSWORD']);

    const env = parseEnv(files.files.get(ENV)!);
    expect(env.TWENTY_ENCRYPTION_KEY).toBe(Buffer.alloc(32, 0xab).toString('base64'));
    expect(env.TWENTY_DB_PASSWORD).toBe('ab'.repeat(32));
    expect(env.COMPOSE_PROFILES).toBe('core');
    expect(env.TWENTY_MCP_ENABLED).toBe('1');
  });

  it('fills empty and change-me values', async () => {
    const files = createFakeStackFiles({ [ENV]: 'TWENTY_ENCRYPTION_KEY=\nTWENTY_DB_PASSWORD=change-me-please\n' });

    expect(await ensureTwentySecrets(files, bytes(1))).toEqual(['TWENTY_ENCRYPTION_KEY', 'TWENTY_DB_PASSWORD']);
    expect(parseEnv(files.files.get(ENV)!).TWENTY_DB_PASSWORD).toBe('01'.repeat(32));
  });

  it('never replaces a value that is set', async () => {
    const before = 'TWENTY_ENCRYPTION_KEY=kept-key\nTWENTY_DB_PASSWORD=kept-password\n';
    const files = createFakeStackFiles({ [ENV]: before });

    expect(await ensureTwentySecrets(files, bytes(2))).toEqual([]);
    expect(files.files.get(ENV)).toBe(before);
  });

  it('leaves a secret alone when its _FILE form is set, since both stop the containers', async () => {
    const files = createFakeStackFiles({
      [ENV]: 'TWENTY_ENCRYPTION_KEY_FILE=/secrets/key\nTWENTY_DB_PASSWORD_FILE=/secrets/db\n',
    });

    expect(await ensureTwentySecrets(files, bytes(3))).toEqual([]);
    const env = parseEnv(files.files.get(ENV)!);
    expect(env.TWENTY_ENCRYPTION_KEY).toBeUndefined();
    expect(env.TWENTY_DB_PASSWORD).toBeUndefined();
  });

  it('does nothing when the stack has no .env', async () => {
    const files = createFakeStackFiles();

    expect(await ensureTwentySecrets(files, bytes(4))).toEqual([]);
    expect(files.files.has(ENV)).toBe(false);
  });
});
