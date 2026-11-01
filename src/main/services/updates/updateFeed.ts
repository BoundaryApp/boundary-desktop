import type { UpdateChannel } from '../../../shared/types/updates';

export interface UpdateOffer {
  version: string;
  /** One line per line of the channel file's `releaseNotes`. */
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

/** Semver precedence, for the data version. Null when either version doesn't parse. */
export function compareVersions(a: string, b: string): number | null {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) {
    if (x.release[i] !== y.release[i]) return x.release[i] - y.release[i];
  }
  return comparePrerelease(x.prerelease, y.prerelease);
}

/** What this service reads from a channel file. Unknown keys reach it unchanged. */
export interface ChannelInfo {
  version: string;
  releaseNotes?: unknown;
  files?: { size?: number }[];
  stackVersion?: unknown;
}

export function parseOffer({ version, releaseNotes, files, stackVersion }: ChannelInfo): UpdateOffer {
  const size = files?.[0]?.size;
  return {
    version,
    summary:
      typeof releaseNotes === 'string'
        ? releaseNotes
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    size: typeof size === 'number' && size > 0 ? size : null,
    stackVersion: typeof stackVersion === 'string' ? stackVersion : null,
  };
}

/** The name electron-updater turns into `<name>-mac.yml`. Only built architectures have a file. */
export function channelName(channel: UpdateChannel, arch: string): string {
  return `${channel}-darwin-${arch}`;
}

export function defaultChannel(version: string): UpdateChannel {
  return version.includes('-') ? 'beta' : 'stable';
}
