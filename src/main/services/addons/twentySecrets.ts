import { randomBytes } from 'node:crypto';
import { parseEnv, upsertEnvLines } from '../assistant/stackEnv';
import type { StackFiles } from '../stackHost/types';

/**
 * Twenty's two secrets in the stack's `.env`, with how the stack's `setup.sh` generates each
 * (stack v0.3.16, `scripts/setup.sh` lines 840–845): the encryption key is 32 random bytes in
 * base64, and the database password is 32 random bytes in hex, because compose puts it unencoded
 * into `PG_DATABASE_URL`.
 */
const SECRETS = [
  { key: 'TWENTY_ENCRYPTION_KEY', encoding: 'base64' },
  { key: 'TWENTY_DB_PASSWORD', encoding: 'hex' },
] as const;

/** Values `setup.sh`'s `set_env_if_placeholder` treats as unset. */
const PLACEHOLDER = /^(change-me|change_me)/;

/**
 * Writes Twenty's encryption key and database password into the stack's `.env` when they are
 * missing, the way `setup.sh` does. Only `setup.sh` generates them, and only from stack v0.3.10, so
 * a stack first set up before that has neither, and `addon.sh enable twenty` starts a database
 * with an empty `POSTGRES_PASSWORD`, which Postgres refuses. A secret whose `_FILE` form is set is
 * left alone, since setting both stops the containers, and a set value is never replaced: Twenty
 * can't read what it stored without the same key. Returns the keys it wrote; none when the stack
 * has no `.env`.
 *
 * Change request 0043: from stack v0.3.17, `addon.sh enable` writes both from the manifest's
 * `generate` list under the same rules, before any service starts, so on the current pin this
 * finds nothing left to write. It stays for trees older than the pin (a developer's own checkout,
 * or a managed tree before its stack update).
 */
export async function ensureTwentySecrets(
  files: StackFiles,
  random: (size: number) => Buffer = randomBytes
): Promise<string[]> {
  const before = await files.readText('stack', '.env');
  if (before === null) return [];
  const env = parseEnv(before);
  const values: Record<string, string> = {};
  for (const { key, encoding } of SECRETS) {
    if (env[`${key}_FILE`]?.trim()) continue;
    const current = env[key]?.trim() ?? '';
    if (current && !PLACEHOLDER.test(current)) continue;
    values[key] = random(32).toString(encoding);
  }
  const written = Object.keys(values);
  if (written.length) await files.writeText('stack', '.env', upsertEnvLines(before, values));
  return written;
}
