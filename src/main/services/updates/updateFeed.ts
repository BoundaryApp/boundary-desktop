import type { UpdateChannel } from '../../../shared/types/updates';

export interface UpdateOffer {
  version: string;
  /** One line per line of the feed's `notes`. */
  summary: string[];
  size: number | null;
  /** The stack version the offered build pins, when the feed names one. */
  stackVersion: string | null;
}

interface ParsedVersion {
  release: number[];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version);
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const [x, y] = [a[i], b[i]];
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}

/**
 * Semver precedence. Squirrel's own check isn't semver (see scripts/write-update-feed.mjs), so
 * this decides what Boundary offers. Null when either version doesn't parse.
 */
export function compareVersions(a: string, b: string): number | null {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.release[i] !== y.release[i]) return x.release[i] - y.release[i];
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}

/** The offer in a feed, read from `updateTo`, or null when the feed has none we can use. */
export function parseFeed(text: string): UpdateOffer | null {
  let feed: unknown;
  try {
    feed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof feed !== 'object' || feed === null) return null;
  const { currentRelease, releases } = feed as { currentRelease?: unknown; releases?: unknown };
  if (typeof currentRelease !== 'string' || !Array.isArray(releases)) return null;
  const entry = releases.find(
    (release: { version?: unknown }) => release?.version === currentRelease
  ) as
    | { updateTo?: { version?: unknown; notes?: unknown; size?: unknown; stackVersion?: unknown } }
    | undefined;
  const version = entry?.updateTo?.version;
  if (typeof version !== 'string' || !parseVersion(version)) return null;
  const { notes, size, stackVersion } = entry?.updateTo ?? {};
  return {
    version,
    summary:
      typeof notes === 'string'
        ? notes
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    size: typeof size === 'number' && size > 0 ? size : null,
    stackVersion: typeof stackVersion === 'string' ? stackVersion : null,
  };
}

export function feedUrl(base: string, channel: UpdateChannel, arch: string): string {
  return `${base.replace(/\/+$/, '')}/${channel}-darwin-${arch}.json`;
}

export function defaultChannel(version: string): UpdateChannel {
  return version.includes('-') ? 'beta' : 'stable';
}
