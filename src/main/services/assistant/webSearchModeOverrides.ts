import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from './stackEnv';

export const WEB_SEARCH_MODE_ENV = 'HERMES_WEB_SEARCH_MODE';

/**
 * Hermes `.env` files that set HERMES_WEB_SEARCH_MODE: `.env` in the Hermes home and in each
 * `profiles/<name>/`. Hermes loads them with override (hermes_cli/env_loader.py), so a line
 * there wins over the value Boundary passes to the container. Paths are relative to the Hermes
 * home. Only the key is checked; values aren't returned.
 */
export async function findWebSearchModeOverrides(hermesHome: string): Promise<string[]> {
  const candidates = ['.env'];
  try {
    const entries = await fs.promises.readdir(path.join(hermesHome, 'profiles'), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join('profiles', entry.name, '.env'));
    }
  } catch {
    /* no profiles folder */
  }
  const found: string[] = [];
  for (const relative of candidates) {
    let contents: string;
    try {
      contents = await fs.promises.readFile(path.join(hermesHome, relative), 'utf8');
    } catch {
      continue;
    }
    if (Object.hasOwn(parseEnv(contents), WEB_SEARCH_MODE_ENV)) found.push(relative);
  }
  return found.sort();
}
