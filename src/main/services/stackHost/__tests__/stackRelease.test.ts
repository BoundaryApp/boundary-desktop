import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchStackRelease, readTarGzFile, verifyStackRelease } from '../stackRelease';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const LONG = `${'deep/'.repeat(25)}file.txt`;

describe('stack release tarballs', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-release-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * A tarball laid out as the stack's release workflow makes it at v0.3.16: one top-level folder
   * named for the release, holding `.stack-version`, `.stack-files` and `scripts/install.sh`.
   */
  function release(version: string, format?: string, stackVersion = version): Buffer {
    const top = path.join(dir, `sovereign-agent-stack-${version}`);
    fs.mkdirSync(path.join(top, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(top, path.dirname(LONG)), { recursive: true });
    fs.writeFileSync(path.join(top, '.stack-version'), `${stackVersion}\n`);
    fs.writeFileSync(path.join(top, '.stack-files'), 'scripts/install.sh\n');
    fs.writeFileSync(path.join(top, 'scripts', 'install.sh'), '#!/usr/bin/env bash\necho install\n');
    fs.writeFileSync(path.join(top, LONG), 'long');
    const out = path.join(dir, `${version}-${format ?? 'default'}.tar.gz`);
    execFileSync('tar', [...(format ? ['--format', format] : []), '-czf', out, '-C', dir, path.basename(top)]);
    fs.rmSync(top, { recursive: true });
    return fs.readFileSync(out);
  }

  it.each([undefined, 'ustar', 'pax'])('reads files from a tarball in %s format, long paths too', (format) => {
    const tarball = release('v1.2.3', format);
    const top = 'sovereign-agent-stack-v1.2.3';
    expect(readTarGzFile(tarball, `${top}/scripts/install.sh`)?.toString()).toBe('#!/usr/bin/env bash\necho install\n');
    expect(readTarGzFile(tarball, `${top}/${LONG}`)?.toString()).toBe('long');
    expect(readTarGzFile(tarball, `${top}/scripts`)).toBeNull();
    expect(readTarGzFile(tarball, `${top}/missing`)).toBeNull();
  });

  it('checks the checksum, in either case, then the version inside, and reads install.sh', () => {
    const tarball = release('v1.2.3');
    const checked = verifyStackRelease(tarball, 'v1.2.3', sha(tarball).toUpperCase());
    expect(checked).toMatchObject({ version: 'v1.2.3', name: 'sovereign-agent-stack-v1.2.3', sha256: sha(tarball) });
    expect(checked.installScript.toString()).toContain('echo install');
    expect(() => verifyStackRelease(tarball, 'v1.2.3', '0'.repeat(64))).toThrow(/didn’t match its pinned checksum/);
    expect(() => verifyStackRelease(tarball, 'v1.2.4', sha(tarball))).toThrow(/isn’t the agent stack's v1\.2\.4 release/);
    const mislabelled = release('v2.0.0', undefined, 'v1.9.9');
    expect(() => verifyStackRelease(mislabelled, 'v2.0.0', sha(mislabelled))).toThrow(/no matching \.stack-version/);
  });

  it('downloads the release asset from GitHub and needs a checksum for an unpinned version', async () => {
    const tarball = release('v1.2.3');
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(tarball)));
    const got = await fetchStackRelease({ version: 'v1.2.3', sha256: sha(tarball), fetchImpl });
    expect(got.tarball.equals(tarball)).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://github.com/kaxline/sovereign-agent-stack/releases/download/v1.2.3/sovereign-agent-stack-v1.2.3.tar.gz'
    );
    await expect(fetchStackRelease({ version: 'v1.2.3', fetchImpl })).rejects.toThrow(/No pinned checksum/);
    const missing = vi.fn<typeof fetch>(async () => new Response('', { status: 404, statusText: 'Not Found' }));
    await expect(fetchStackRelease({ version: 'v1.2.3', sha256: sha(tarball), fetchImpl: missing })).rejects.toThrow(/404 Not Found/);
  });
});
