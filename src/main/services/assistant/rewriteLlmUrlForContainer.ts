/**
 * True for host names that point at this machine. `URL.hostname` keeps the brackets on IPv6,
 * so both `::1` and `[::1]` are accepted. A server bound to `0.0.0.0` is reached on the host.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '0.0.0.0'
  );
}

/**
 * Rewrite loopback OpenAI-compatible URLs so Hermes-in-Docker can reach the host.
 * Cloud / non-loopback URLs are left unchanged.
 */
export function rewriteLlmUrlForContainer(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    if (isLoopbackHostname(url.hostname)) {
      url.hostname = 'host.docker.internal';
      return url.toString().replace(/\/$/, '');
    }
    return endpointUrl.replace(/\/$/, '');
  } catch {
    return endpointUrl
      .replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/]|$)/i, '$1host.docker.internal')
      .replace(/\/$/, '');
  }
}
