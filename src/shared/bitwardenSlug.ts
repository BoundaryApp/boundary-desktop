// The checks `vault.sh add --json` makes (stack scripts/vault.sh, CR 0028), so the connect sheet
// never sends what the stack would refuse as `bad_input` or `bad_slug`.

import { ADDON_SLUG } from './utils/slug';

/**
 * A new account's name (spec decision 28, the add-on store's rule, ADDON_SLUG). `local` is the
 * stack's own Vaultwarden account and is refused.
 */
export function isBitwardenSlug(value: unknown): value is string {
  return typeof value === 'string' && ADDON_SLUG.test(value) && value !== 'local';
}

/** A self-hosted server's address after trailing slashes are dropped: HTTPS, a host, an optional port and path. */
const SERVER_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[^\s?#]*)?$/;

/** The address `vault.sh` would store, or null when it would refuse it. */
export function bitwardenServerUrl(value: string): string | null {
  const url = value.trim().replace(/\/+$/, '');
  return SERVER_URL.test(url) ? url : null;
}

/** A folder name: not empty, no space at either end, no `"` and no control characters. */
export function isBitwardenFolder(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name !== '' && name === name.trim() && !/["\u0000-\u001f\u007f]/.test(name);
}

/** An organization collection's ID, as Bitwarden shows it. */
export const BITWARDEN_COLLECTION = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** `folder:<name>` or `collection:<id>` that `vault.sh` accepts. `all` is never sent from Boundary. */
export function isBitwardenScope(scope: string): boolean {
  if (scope.startsWith('folder:')) return isBitwardenFolder(scope.slice('folder:'.length));
  if (scope.startsWith('collection:')) return BITWARDEN_COLLECTION.test(scope.slice('collection:'.length));
  return false;
}
