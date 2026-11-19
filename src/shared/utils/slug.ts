export interface SlugifyOptions {
  /** Longest slug kept. Hyphens left at the end by the cut are removed. */
  max?: number;
  /** Returned when the text has no letters or digits. Defaults to ''. */
  fallback?: string;
  /** Drop accents first, so `Café` becomes `cafe` rather than `caf`. */
  stripDiacritics?: boolean;
}

/**
 * Lowercase `text`, turn each run of characters other than a-z and 0-9 into one hyphen,
 * and drop hyphens at either end.
 */
export function slugify(text: string, options: SlugifyOptions = {}): string {
  const plain = options.stripDiacritics ? text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') : text;
  let slug = plain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (options.max !== undefined) slug = slug.slice(0, options.max).replace(/-+$/, '');
  return slug || (options.fallback ?? '');
}

/** `base` if nothing in `taken` uses it, otherwise the first free `base-2`, `base-3`, … */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * The add-on store's account and workspace name rule, shared by the stack's Actual, Bitwarden,
 * IMAP and Twenty scripts: a letter, then up to 30 of a-z, 0-9 and `-`.
 */
export const ADDON_SLUG_PATTERN = '[a-z][a-z0-9-]{0,30}';
export const ADDON_SLUG = new RegExp(`^${ADDON_SLUG_PATTERN}$`);

/**
 * A name that passes ADDON_SLUG: accents dropped, lowercase, dashes for everything else,
 * leading digits removed and at most 31 characters. `fallback` when nothing is left.
 */
export function addonSlugFromName(name: string, fallback: string): string {
  const slug = slugify(name, { stripDiacritics: true }).replace(/^[^a-z]+/, '');
  return slugify(slug, { max: 31, fallback });
}
