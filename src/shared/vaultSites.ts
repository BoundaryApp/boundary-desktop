/**
 * Where common sites keep their sign-in form. Hermes fills a saved password only on the
 * exact origin it was saved for, so a login saved for a profile or home page
 * (https://linkedin.com) is never used on the real sign-in page (https://www.linkedin.com).
 */
export interface KnownSignInSite {
  name: string;
  /** Registrable domain, used to spot a near miss. */
  domain: string;
  origin: string;
}

export const KNOWN_SIGN_IN_SITES: readonly KnownSignInSite[] = [
  {
    name: 'LinkedIn',
    domain: 'linkedin.com',
    origin: 'https://www.linkedin.com',
  },
  { name: 'GitHub', domain: 'github.com', origin: 'https://github.com' },
  {
    name: 'Google',
    domain: 'google.com',
    origin: 'https://accounts.google.com',
  },
  { name: 'Amazon', domain: 'amazon.com', origin: 'https://www.amazon.com' },
  { name: 'X', domain: 'x.com', origin: 'https://x.com' },
  {
    name: 'Facebook',
    domain: 'facebook.com',
    origin: 'https://www.facebook.com',
  },
  {
    name: 'Instagram',
    domain: 'instagram.com',
    origin: 'https://www.instagram.com',
  },
  { name: 'Reddit', domain: 'reddit.com', origin: 'https://www.reddit.com' },
  { name: 'Notion', domain: 'notion.so', origin: 'https://www.notion.so' },
  { name: 'Microsoft', domain: 'live.com', origin: 'https://login.live.com' },
];

/**
 * The origin (`scheme://host[:port]`) of a URL or bare host the user typed, or null when
 * the text isn't one (e.g. a site name like "LinkedIn"). Only http and https count.
 */
export function originFromInput(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value) || !/[.:/]/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname;
    if (!host || (!host.includes('.') && host !== 'localhost')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Known sites whose name or domain starts with what the user typed. */
export function suggestSignInSites(text: string): KnownSignInSite[] {
  const q = text.trim().toLowerCase();
  if (!q || originFromInput(text)) return [];
  return KNOWN_SIGN_IN_SITES.filter(
    (s) => s.name.toLowerCase().startsWith(q) || s.domain.startsWith(q)
  );
}

export function knownSiteForOrigin(origin: string): KnownSignInSite | undefined {
  return KNOWN_SIGN_IN_SITES.find((s) => s.origin === origin);
}

/**
 * The known site whose sign-in form lives on a different origin than `origin`, when
 * `origin` belongs to that site. Null for unknown sites and exact matches.
 */
export function signInOriginMismatch(origin: string): KnownSignInSite | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const site = KNOWN_SIGN_IN_SITES.find((s) => host === s.domain || host.endsWith(`.${s.domain}`));
  return site && site.origin !== origin ? site : null;
}

/** A readable label for a login with no name of its own: the known site, else the host. */
export function labelForOrigin(origin: string): string {
  const known = knownSiteForOrigin(origin);
  if (known) return known.name;
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}
