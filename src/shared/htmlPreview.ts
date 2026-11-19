import { uniquePreserveOrder } from './hermesToolPaths';

/** Where `ASSISTANT_DATA_ROOT/projects` is mounted in the hermes containers. */
export const PROJECTS_CONTAINER_ROOT = '/opt/projects';

/** Largest page the preview sheet loads. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Policy for the sandboxed preview frame: inline script and style, and data/blob
 * media only, so a page cannot fetch anything or load remote resources.
 * Contains no double quote, so it sits unescaped in a meta `content` attribute.
 */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

/** True for `.html` and `.htm` paths, in any case. */
export function isPreviewablePath(p: string): boolean {
  return /\.html?$/i.test(p);
}

/**
 * Page source with the CSP meta first, so it applies before any of the page's own
 * markup. A doctype stays ahead of the meta to keep standards mode; a leading BOM
 * is dropped, and so is whitespace before a doctype.
 */
export function previewSrcdoc(html: string): string {
  const body = html.replace(/^\uFEFF/, '');
  const trimmed = body.replace(/^\s+/, '');
  const doctype = trimmed.match(/^<!doctype[^>]*>\s*/i);
  if (!doctype) return `${CSP_META}${body}`;
  return `${doctype[0]}${CSP_META}${trimmed.slice(doctype[0].length)}`;
}

/** Previewable absolute paths under the projects mount, without `..`, de-duplicated in order. */
export function previewablePathsOf(paths: string[]): string[] {
  const prefix = `${PROJECTS_CONTAINER_ROOT}/`;
  return uniquePreserveOrder(
    paths.filter(
      (p) =>
        p.startsWith(prefix) &&
        !p.split('/').includes('..') &&
        isPreviewablePath(p)
    )
  );
}
