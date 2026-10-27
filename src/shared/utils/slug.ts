export interface SlugifyOptions {
  /** Longest slug kept. Hyphens left at the end by the cut are removed. */
  max?: number;
  /** Returned when the text has no letters or digits. Defaults to ''. */
  fallback?: string;
}

/**
 * Lowercase `text`, turn each run of characters other than a-z and 0-9 into one hyphen,
 * and drop hyphens at either end.
 */
export function slugify(text: string, options: SlugifyOptions = {}): string {
  let slug = text
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
