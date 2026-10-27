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
