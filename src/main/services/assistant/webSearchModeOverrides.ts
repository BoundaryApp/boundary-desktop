import type { StackFiles } from '../stackHost/types';
import { parseEnv } from './stackEnv';

export const WEB_SEARCH_MODE_ENV = 'HERMES_WEB_SEARCH_MODE';

/**
 * Hermes `.env` files that set HERMES_WEB_SEARCH_MODE: `.env` in the Hermes home and in each
 * `profiles/<name>/`. Hermes loads them with override (hermes_cli/env_loader.py), so a line
 * there wins over the value Boundary passes to the container. Paths are relative to the Hermes
 * home (`hermes/` in the stack's data). Only the key is checked; values aren't returned.
 */
export async function findWebSearchModeOverrides(files: StackFiles): Promise<string[]> {
  const candidates = ['.env'];
  try {
    for (const name of (await files.list('data', 'hermes/profiles')) ?? []) {
      candidates.push(`profiles/${name}/.env`);
    }
  } catch {
    /* no profiles folder */
  }
  const found: string[] = [];
  for (const relative of candidates) {
    let contents: string | null;
    try {
      contents = await files.readText('data', `hermes/${relative}`);
    } catch {
      continue;
    }
    if (contents !== null && Object.hasOwn(parseEnv(contents), WEB_SEARCH_MODE_ENV)) found.push(relative);
  }
  return found.sort();
}
