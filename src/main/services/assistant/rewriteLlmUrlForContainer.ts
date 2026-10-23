/**
 * Rewrite loopback OpenAI-compatible URLs so Hermes-in-Docker can reach the host.
 * Cloud / non-loopback URLs are left unchanged.
 */
export function rewriteLlmUrlForContainer(endpointUrl: string): string {
  try {
    const url = new URL(endpointUrl);
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      url.hostname = 'host.docker.internal';
      return url.toString().replace(/\/$/, '');
    }
    return endpointUrl.replace(/\/$/, '');
  } catch {
    return endpointUrl
      .replace(/^(https?:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i, '$1host.docker.internal')
      .replace(/\/$/, '');
  }
}
