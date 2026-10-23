import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import type { BrowserRelayConfig } from './browserRelay';
import { DEFAULT_BLOCKED_SITES, normalizeSite, type SitePolicy } from './cdpPolicy';
import type { HostBridgeBrowserSettings } from './hostBridgeStore';

/**
 * Main-side settings for Boundary's browser (ADR 0027 §4, §6): where Chrome is, which profile
 * folder it uses, and the site lists.
 */

export function findGoogleChrome(platform = process.platform, home = os.homedir()): string | null {
  if (platform !== 'darwin') return null;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Boundary's own Chrome profile: separate from the user's, logins the user chose to add. */
export function boundaryBrowserProfileDir(): string {
  return path.join(app.getPath('userData'), 'agent-browser', 'profile');
}

function cleanSites(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const site = normalizeSite(entry);
    if (site && !out.includes(site)) out.push(site);
  }
  return out;
}

export function sitePolicyFrom(settings: HostBridgeBrowserSettings): SitePolicy {
  return {
    blocked: cleanSites(settings.blocked ?? DEFAULT_BLOCKED_SITES),
    allowed: cleanSites(settings.allowed),
  };
}

export function browserRelayConfigFrom(
  settings: HostBridgeBrowserSettings,
  chromePath = findGoogleChrome()
): BrowserRelayConfig {
  return {
    enabled: settings.enabled,
    chrome: chromePath ? { chromePath, profileDir: boundaryBrowserProfileDir() } : null,
    policy: sitePolicyFrom(settings),
  };
}

/** Store edited lists as bare hosts, and go back to the default list when it is unchanged. */
export function normalizeBrowserSettings(settings: HostBridgeBrowserSettings): HostBridgeBrowserSettings {
  const blocked = settings.blocked === null ? null : cleanSites(settings.blocked);
  const isDefault =
    blocked !== null &&
    blocked.length === DEFAULT_BLOCKED_SITES.length &&
    blocked.every((site, i) => site === DEFAULT_BLOCKED_SITES[i]);
  return { enabled: Boolean(settings.enabled), blocked: isDefault ? null : blocked, allowed: cleanSites(settings.allowed) };
}
