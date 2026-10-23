import type Dockerode from 'dockerode';

/**
 * Convert a Docker-style API endpoint URL into dockerode constructor options.
 */
export function dockerodeOptionsFromApiEndpoint(
  apiEndpoint: string
): Dockerode.DockerOptions {
  if (apiEndpoint.startsWith('unix://')) {
    return { socketPath: apiEndpoint.slice('unix://'.length) };
  }
  if (apiEndpoint.startsWith('npipe://')) {
    return { socketPath: apiEndpoint.slice('npipe://'.length) };
  }
  if (apiEndpoint.startsWith('tcp://') || apiEndpoint.startsWith('http://')) {
    const url = new URL(apiEndpoint.replace(/^tcp:\/\//, 'http://'));
    return {
      protocol: 'http',
      host: url.hostname,
      port: url.port ? Number(url.port) : 2375,
    };
  }
  if (apiEndpoint.startsWith('https://')) {
    const url = new URL(apiEndpoint);
    return {
      protocol: 'https',
      host: url.hostname,
      port: url.port ? Number(url.port) : 2376,
    };
  }
  // Treat bare paths as unix sockets
  return { socketPath: apiEndpoint };
}

export function defaultDockerApiEndpoint(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.DOCKER_HOST) {
    return env.DOCKER_HOST;
  }
  if (platform === 'win32') {
    return 'npipe:////./pipe/docker_engine';
  }
  return 'unix:///var/run/docker.sock';
}
