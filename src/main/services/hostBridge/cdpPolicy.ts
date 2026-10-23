/**
 * What the browser relay lets through (ADR 0027 §5–6). Pure functions so they can be tested
 * without a browser.
 *
 * Commands: a denylist of the methods that read or export credentials wholesale, plus a few that
 * hand control to someone else. Everything else passes and is counted, so a traced run of
 * Hermes's driver can turn this into an allowlist later.
 *
 * Sites: every navigation the relay can see is checked. `file:` and browser-internal pages are
 * always refused (the agent's browser runs on the Mac and could read local files or settings).
 */

/** Refused outright, whatever the session. */
const BLOCKED_METHODS = new Set([
  'Network.getAllCookies',
  'Network.getCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
  'Storage.clearDataForOrigin',
  'Storage.clearDataForStorageKey',
  'IO.read',
  // Gives page JavaScript a CDP binding of its own.
  'Target.exposeDevToolsProtocol',
]);

/** Whole domains that are storage or request interception. */
const BLOCKED_DOMAINS = ['Fetch.', 'DOMStorage.', 'IndexedDB.', 'CacheStorage.'];

/**
 * Hermes answers page dialogs (alert, confirm) through a "dialog bridge": a page script sends a
 * request to this fake host, and Hermes intercepts it with Fetch and replies. Interception is
 * allowed for this host only, so nothing can intercept real traffic.
 */
export const HERMES_DIALOG_BRIDGE_PREFIX = 'http://hermes-dialog-bridge.invalid/';

/** Answering a paused request. Only bridge requests can be paused, since that's all Fetch.enable allows. */
const FETCH_ANSWERS = new Set(['Fetch.fulfillRequest', 'Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.disable']);

function isDialogBridgeFetchEnable(params: Record<string, unknown> | undefined): boolean {
  const patterns = params?.patterns;
  return (
    params?.handleAuthRequests !== true &&
    Array.isArray(patterns) &&
    patterns.length > 0 &&
    patterns.every(
      (pattern) =>
        typeof pattern?.urlPattern === 'string' && pattern.urlPattern.startsWith(HERMES_DIALOG_BRIDGE_PREFIX)
    )
  );
}

export function blockedMethodReason(method: string, params?: Record<string, unknown>): string | null {
  if (method === 'Fetch.enable' && isDialogBridgeFetchEnable(params)) return null;
  if (FETCH_ANSWERS.has(method)) return null;
  if (BLOCKED_METHODS.has(method) || BLOCKED_DOMAINS.some((prefix) => method.startsWith(prefix))) {
    return `Boundary's browser doesn't allow ${method}: it reads or changes stored logins and site data.`;
  }
  return null;
}

export interface SitePolicy {
  /** Domains (and their subdomains) the agent may not open. */
  blocked: string[];
  /** When not empty, the only domains (and subdomains) the agent may open. */
  allowed: string[];
}

/** Email, password managers, payments and banks: blocked until the user says otherwise. */
export const DEFAULT_BLOCKED_SITES: readonly string[] = [
  'mail.google.com',
  'myaccount.google.com',
  'passwords.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'icloud.com',
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
  'dashlane.com',
  'keepersecurity.com',
  'paypal.com',
  'venmo.com',
  'wise.com',
  'stripe.com',
  'coinbase.com',
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'capitalone.com',
  'americanexpress.com',
  'schwab.com',
  'fidelity.com',
  'vanguard.com',
];

/** Schemes that never leave the page or the network: always fine. */
const NEUTRAL_SCHEMES = new Set(['about:', 'data:', 'blob:', 'javascript:']);

/** Normalise a user-entered site to a bare host: "https://Example.com/x" → "example.com". */
export function normalizeSite(entry: string): string | null {
  const trimmed = entry.trim().toLowerCase().replace(/^\*\./, '');
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

function hostMatches(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** `null` when the agent may open `url`, otherwise why not. */
export function blockedUrlReason(url: string, policy: SitePolicy): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null; // Not a URL Chrome would navigate to either.
  }
  if (NEUTRAL_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Boundary's browser doesn't open ${parsed.protocol} pages.`;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const blocked = policy.blocked.find((site) => hostMatches(host, site));
  if (blocked) return `${blocked} is on Boundary's blocked-sites list.`;
  if (policy.allowed.length && !policy.allowed.some((site) => hostMatches(host, site))) {
    return `${host} isn't on Boundary's allowed-sites list.`;
  }
  return null;
}
