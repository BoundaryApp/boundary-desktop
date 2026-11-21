import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  SOVEREIGN_AGENT_STACK_RELEASE_SHA256,
  SOVEREIGN_AGENT_STACK_VERSION,
  sovereignAgentStackReleaseName,
  sovereignAgentStackReleaseUrl,
} from '../../../shared/assistantStackConstants';

/** A stack release tarball whose checksum matched its pin, with the files Boundary reads from it. */
export interface StackRelease {
  version: string;
  /** `sovereign-agent-stack-<version>`: the tarball's top-level folder and file name. */
  name: string;
  tarball: Buffer;
  /** Lowercase hex. */
  sha256: string;
  /** The release's `scripts/install.sh` (CR 0037 R1), which installs it on a host. */
  installScript: Buffer;
}

const isZeroBlock = (block: Buffer) => block.every((byte) => byte === 0);

/** A NUL-terminated header field. */
function headerField(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

/** `path` from a pax extended header (`<len> path=<value>\n` records), or null. */
function paxPath(data: Buffer): string | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(at, space).toString('latin1'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    at += length;
  }
  return null;
}

/**
 * One regular file from a gzipped tar, by its path in the archive, or null when it has none.
 * Reads ustar, GNU long names (`L`) and pax `path` records, which is what `tar` writes on Linux
 * and macOS.
 */
export function readTarGzFile(tarGz: Buffer, wanted: string): Buffer | null {
  const tar = gunzipSync(tarGz);
  let offset = 0;
  let longName: string | null = null;
  let extendedPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    const size = Number.parseInt(headerField(header, 124, 12).trim() || '0', 8);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    let name = headerField(header, 0, 100);
    // POSIX ustar splits long paths into prefix and name; GNU's "ustar  " uses those bytes otherwise.
    if (header.subarray(257, 263).toString('latin1') === 'ustar\0') {
      const prefix = headerField(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const start = offset + 512;
    const data = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      extendedPath = paxPath(data);
      continue;
    }
    if (type === 'g') continue;
    const entry = (extendedPath ?? longName ?? name).replace(/^\.\//, '');
    longName = extendedPath = null;
    if ((type === '0' || type === '7') && entry === wanted) return Buffer.from(data);
  }
  return null;
}

/**
 * Checks a release tarball against its pinned SHA-256 and reads `install.sh` from it. Throws
 * when the checksum differs or the tarball isn't the stack release it should be, so nothing from
 * an unchecked tarball reaches a host.
 */
export function verifyStackRelease(tarball: Buffer, version: string, sha256: string): StackRelease {
  const name = sovereignAgentStackReleaseName(version);
  const actual = createHash('sha256').update(tarball).digest('hex');
  const expected = sha256.toLowerCase();
  if (actual !== expected) {
    throw new Error(`The agent stack release ${name}.tar.gz didn’t match its pinned checksum (expected ${expected}, got ${actual}).`);
  }
  const stackVersion = readTarGzFile(tarball, `${name}/.stack-version`)?.toString('utf8').split('\n')[0].trim();
  const installScript = readTarGzFile(tarball, `${name}/scripts/install.sh`);
  if (stackVersion !== version || !installScript) {
    throw new Error(`${name}.tar.gz isn’t the agent stack's ${version} release: it has no matching .stack-version or no scripts/install.sh.`);
  }
  return { version, name, tarball, sha256: expected, installScript };
}

/**
 * Downloads a stack release tarball from GitHub and checks it (`verifyStackRelease`). The
 * checksum defaults to the pin for the pinned version; another version needs one passed.
 */
export async function fetchStackRelease(
  options: { version?: string; sha256?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<StackRelease> {
  const version = options.version ?? SOVEREIGN_AGENT_STACK_VERSION;
  const sha256 = options.sha256 ?? (version === SOVEREIGN_AGENT_STACK_VERSION ? SOVEREIGN_AGENT_STACK_RELEASE_SHA256 : null);
  if (!sha256) throw new Error(`No pinned checksum for the agent stack release ${version}.`);
  const url = sovereignAgentStackReleaseUrl(version);
  const response = await (options.fetchImpl ?? fetch)(url, { signal: options.signal });
  if (!response.ok) {
    throw new Error(`Couldn’t download the agent stack release (${response.status} ${response.statusText}): ${url}`);
  }
  return verifyStackRelease(Buffer.from(await response.arrayBuffer()), version, sha256);
}
