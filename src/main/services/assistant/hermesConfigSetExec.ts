/** Env var that carries a secret config value from Boundary into `compose exec`. */
export const HERMES_CONFIG_SECRET_ENV = 'BOUNDARY_HERMES_CONFIG_SECRET';

/**
 * Build the `compose exec` args for `hermes config set <key> <value>` in one profile.
 *
 * A secret value never goes on the command line (host `ps`, and Node's
 * "Command failed: …" error text). It rides in the compose process's env and is
 * forwarded by name with `-e`, then expanded by a shell inside the container.
 */
export function buildHermesConfigSetExec(
  profile: string,
  key: string,
  value: string,
  options: { secret?: boolean } = {}
): { args: string[]; env?: NodeJS.ProcessEnv } {
  const hermesArgs = profile === '' ? ['hermes'] : ['hermes', '-p', profile];
  if (!options.secret) {
    return { args: ['exec', '-T', 'hermes', ...hermesArgs, 'config', 'set', key, value] };
  }
  return {
    args: [
      'exec',
      '-T',
      '-e',
      HERMES_CONFIG_SECRET_ENV,
      'hermes',
      'sh',
      '-c',
      `exec "$@" "$${HERMES_CONFIG_SECRET_ENV}"`,
      'sh',
      ...hermesArgs,
      'config',
      'set',
      key,
    ],
    env: { [HERMES_CONFIG_SECRET_ENV]: value },
  };
}

/**
 * Read one config value. `hermes config get` exits 1 for an unset key, which Compose would
 * report as a failure, so the shell turns that into stdout: see {@link parseHermesConfigGet}.
 */
export function buildHermesConfigGetExec(profile: string, key: string): { args: string[] } {
  const hermesArgs = profile === '' ? ['hermes'] : ['hermes', '-p', profile];
  return {
    args: ['exec', '-T', 'hermes', 'sh', '-c', '"$@" || true', 'sh', ...hermesArgs, 'config', 'get', key],
  };
}

/** The value, `null` for an unset key, or `undefined` when the output is neither (an error). */
export function parseHermesConfigGet(stdout: string): string | null | undefined {
  const text = stdout.trim();
  if (/^Config key not set\b/m.test(text)) return null;
  if (!text || /^Error\b/m.test(text) || text.includes('\n')) return undefined;
  return text;
}

/** Replace every occurrence of each non-empty secret in `text`. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}
