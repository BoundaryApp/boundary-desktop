/** Joining and comparing OpenAI-compatible endpoint URLs, for main and the renderer. */

/** `base` joined to `path` with one slash, e.g. `endpointPath(url, 'models')`. */
export function endpointPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function canonicalEndpoint(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/**
 * Whether two endpoint URLs name the same endpoint: scheme and host compared without case,
 * a default port and trailing slashes ignored. A missing URL matches nothing.
 */
export function sameEndpoint(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  return canonicalEndpoint(a) === canonicalEndpoint(b);
}

/** Whether the URL's host is OpenRouter's. An unparsable URL is not. */
export function isOpenRouterUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.includes('openrouter.ai');
  } catch {
    return false;
  }
}
