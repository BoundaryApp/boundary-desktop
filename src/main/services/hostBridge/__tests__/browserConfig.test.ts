import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserRelayConfigFrom, findGoogleChrome, normalizeBrowserSettings, sitePolicyFrom } from '../browserConfig';
import { DEFAULT_BLOCKED_SITES } from '../cdpPolicy';

describe('browser settings', () => {
  it('uses the default blocked list until the user edits it', () => {
    expect(sitePolicyFrom({ enabled: true, blocked: null, allowed: [] }).blocked).toEqual([...DEFAULT_BLOCKED_SITES]);
    expect(sitePolicyFrom({ enabled: true, blocked: ['https://www.Example.com/x', 'example.com', ''], allowed: [] }).blocked).toEqual([
      'example.com',
    ]);
  });

  it('stores edited lists as bare hosts and an unchanged list as the default', () => {
    expect(normalizeBrowserSettings({ enabled: true, blocked: [...DEFAULT_BLOCKED_SITES], allowed: [] }).blocked).toBeNull();
    expect(normalizeBrowserSettings({ enabled: true, blocked: ['https://a.com/', 'a.com'], allowed: ['LinkedIn.com'] })).toEqual({
      enabled: true,
      blocked: ['a.com'],
      allowed: ['linkedin.com'],
    });
  });

  it('has no Chrome to launch without Google Chrome', () => {
    expect(browserRelayConfigFrom({ enabled: true, blocked: null, allowed: [] }, null).chrome).toBeNull();
  });

  it('finds Chrome in the user’s Applications folder too, on macOS only', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-find-'));
    try {
      const bin = path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '');
      const found = findGoogleChrome('darwin', home);
      // The system-wide install wins when both exist.
      expect([bin, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']).toContain(found);
      expect(findGoogleChrome('linux', home)).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
