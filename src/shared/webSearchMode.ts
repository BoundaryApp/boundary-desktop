/**
 * Who answers Hermes's `searxng_web_search` and `web_url_read` (the stack's
 * HERMES_WEB_SEARCH_MODE, docs/searxng.md "Search modes" in the stack). `private` is SearXNG
 * and a plain fetch from this machine; the others also use, or only use, Hermes's keyless
 * services: the anonymous free tiers of Exa, Parallel, Firecrawl and Keenable.
 */
export const WEB_SEARCH_MODES = ['private', 'private-first', 'keyless-first', 'keyless'] as const;

export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = 'private';

/** First stack release whose Hermes reads HERMES_WEB_SEARCH_MODE. Older pins ignore it. */
export const WEB_SEARCH_MODE_MIN_STACK_VERSION = 'v0.3.11';

export function isWebSearchMode(value: unknown): value is WebSearchMode {
  return typeof value === 'string' && (WEB_SEARCH_MODES as readonly string[]).includes(value);
}

/** Whether `version` (`vMAJOR.MINOR.PATCH`) is `min` or later. An unparsable version is not. */
export function stackVersionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

export interface WebSearchModeState {
  mode: WebSearchMode;
  /** The pinned stack reads the setting. While false, Settings doesn't offer it. */
  available: boolean;
  /** Boundary decides the mode; false under dev:local-stack, where the checkout's .env does. */
  canChange: boolean;
  /**
   * Hermes `.env` files under the data folder that set HERMES_WEB_SEARCH_MODE, relative to the
   * Hermes home. Hermes loads them over the container's environment, so they win over this
   * setting.
   */
  overrides: string[];
}
