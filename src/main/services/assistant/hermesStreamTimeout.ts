import net from 'node:net';

/**
 * Hermes treats the dotless `llm-proxy` host as a local server whatever sits behind it, so
 * its stale-stream timeout has to be sized for the real upstream. The stack's bootstrap
 * does this from LLM_BINDING_HOST, but only when the stack comes up; Boundary sets it again
 * on every model change. Same rule and values as `upstream_is_local` in the stack's
 * compose/hermes/bootstrap-api-profile.sh.
 */

const HERMES_STALE_TIMEOUT_LOCAL_S = 300;
const HERMES_STALE_TIMEOUT_CLOUD_S = 180;

function ipv4IsLocal(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function ipv6IsLocal(host: string): boolean {
  const h = host.toLowerCase();
  return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

/** True for a model server on this machine or the local network. */
export function upstreamIsLocal(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (!host || host === 'localhost') return true;
  const family = net.isIP(host);
  if (family === 4) return ipv4IsLocal(host);
  if (family === 6) return ipv6IsLocal(host);
  return (
    !host.includes('.') ||
    ['.local', '.internal', '.lan', '.home.arpa'].some((suffix) => host.endsWith(suffix))
  );
}

/**
 * Seconds for `agent.local_stream_stale_timeout`. `override` is HERMES_PROXY_STALE_TIMEOUT
 * from the stack .env, which wins when it is a positive number, as in the bootstrap.
 */
export function hermesStaleTimeoutFor(upstreamUrl: string, override?: string): number {
  const forced = Number(override?.trim());
  if (override?.trim() && Number.isFinite(forced) && forced > 0) return forced;
  return upstreamIsLocal(upstreamUrl) ? HERMES_STALE_TIMEOUT_LOCAL_S : HERMES_STALE_TIMEOUT_CLOUD_S;
}
