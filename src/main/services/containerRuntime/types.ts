export type RuntimeKind = 'docker' | 'podman';
export type RuntimeOrigin = 'system' | 'bundled';

export type ContainerRuntime = {
  kind: RuntimeKind;
  origin: RuntimeOrigin;
  /** Absolute or PATH-resolved CLI binary name/path. */
  cliPath: string;
  /**
   * Optional standalone Compose v2 binary (e.g. vendored `docker-compose`).
   * When set, `runCompose` invokes this instead of `cliPath` + `composeArgv`.
   */
  composeBinaryPath?: string;
  /** Compose subcommand argv prefix, e.g. `['compose']`. Empty when using composeBinaryPath. */
  composeArgv: readonly string[];
  /** Environment for CLI and API clients (includes DOCKER_HOST when set). */
  env: NodeJS.ProcessEnv;
  /**
   * Docker-compatible API endpoint for dockerode.
   * Examples: `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine`.
   */
  apiEndpoint: string;
  version: {
    cli: string;
    compose: string | null;
  };
};

export class ContainerRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerRuntimeUnavailableError';
  }
}
