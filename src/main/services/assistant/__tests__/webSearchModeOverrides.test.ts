import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findWebSearchModeOverrides } from '../webSearchModeOverrides';
import { stackVersionAtLeast } from '../../../../shared/webSearchMode';

const dirs: string[] = [];

function hermesHome(files: Record<string, string>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-'));
  dirs.push(home);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return home;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('findWebSearchModeOverrides', () => {
  it('lists the home and profile .env files that set the key, commented lines excluded', async () => {
    const home = hermesHome({
      '.env': 'OTHER=1\nexport HERMES_WEB_SEARCH_MODE=keyless\n',
      'profiles/browser/.env': '# HERMES_WEB_SEARCH_MODE=keyless\n',
      'profiles/api-server/.env': 'HERMES_WEB_SEARCH_MODE=\n',
      'profiles/empty/notes.txt': 'x',
    });
    expect(await findWebSearchModeOverrides(home)).toEqual(['.env', 'profiles/api-server/.env']);
  });

  it('is empty when the home is missing', async () => {
    expect(await findWebSearchModeOverrides(path.join(os.tmpdir(), 'wsm-missing-home'))).toEqual([]);
  });
});

describe('stackVersionAtLeast', () => {
  it('compares major, minor and patch numerically', () => {
    expect(stackVersionAtLeast('v0.3.10', 'v0.3.11')).toBe(false);
    expect(stackVersionAtLeast('v0.3.11', 'v0.3.11')).toBe(true);
    expect(stackVersionAtLeast('v0.3.12', 'v0.3.11')).toBe(true);
    expect(stackVersionAtLeast('v0.4.0', 'v0.3.11')).toBe(true);
    expect(stackVersionAtLeast('v1.0.0', 'v0.3.11')).toBe(true);
  });

  it('treats an unparsable version as too old', () => {
    expect(stackVersionAtLeast('main', 'v0.3.11')).toBe(false);
  });
});
