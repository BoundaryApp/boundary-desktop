#!/usr/bin/env node
// Write the update files for one channel (docs/updates-plan.md decision 4): the channel file
// electron-updater reads, and the Squirrel.Mac JSON feed that 0.0.1-rc.13 and earlier read.
//
//   node scripts/write-update-feed.mjs --channel beta|stable --version 0.0.1-rc.9 --zip <path>
//     --repo owner/name --out <path> --channel-out <path> [--notes-file <path>]
//     [--zip-base-url <url>]
//
// --zip-base-url replaces the GitHub release URL, for a local rehearsal.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Squirrel compares the running version with `currentRelease` by NSNumericSearch, which sorts
 * 0.0.1-rc.9 after 0.0.1, so an RC would refuse its own final release. On the beta feed a final
 * release takes a label that sorts after every RC of that version. `updateTo` keeps the real
 * version, which is what Boundary's own check reads.
 */
export function feedLabel(channel, version) {
  return channel === 'beta' && !version.includes('-') ? `${version}-rc.999999` : version;
}

/**
 * The stack version this checkout pins. Boundary compares it with its own to tell whether an
 * update moves the stack, which makes the first start after it take minutes.
 */
export function pinnedStackVersion(constantsSource) {
  return /SOVEREIGN_AGENT_STACK_VERSION = '([^']+)'/.exec(constantsSource)?.[1];
}

export function buildFeed({ channel, version, url, sha256, size, notes, stackVersion, pubDate }) {
  const label = feedLabel(channel, version);
  return {
    currentRelease: label,
    releases: [
      {
        version: label,
        updateTo: {
          name: `Boundary ${version}`,
          version,
          pub_date: pubDate,
          url,
          sha256,
          size,
          notes,
          stackVersion,
        },
      },
    ],
  };
}

/** electron-updater parses this as YAML. JSON is valid YAML, so it needs no YAML writer. */
export function buildChannelFile({ version, url, sha512, size, notes, stackVersion, pubDate }) {
  return {
    version,
    files: [{ url, sha512, size }],
    releaseDate: pubDate,
    releaseNotes: notes,
    stackVersion,
  };
}

function hashFile(path, algorithm, encoding) {
  return new Promise((done, fail) => {
    const hash = createHash(algorithm);
    createReadStream(path)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest(encoding)));
  });
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Bad argument: ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function main() {
  const {
    channel,
    version,
    zip,
    repo,
    out,
    'channel-out': channelOut,
    'notes-file': notesFile,
    'zip-base-url': zipBase,
  } = parseArgs(process.argv.slice(2));
  if (channel !== 'beta' && channel !== 'stable') throw new Error('--channel must be beta or stable');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error('--version must look like 0.0.1 or 0.0.1-rc.9, with no leading v');
  }
  if (!zip || !repo || !out || !channelOut) {
    throw new Error('--zip, --repo, --out and --channel-out are required');
  }
  const release = {
    version,
    url: `${zipBase ?? `https://github.com/${repo}/releases/download/v${version}`}/${basename(zip)}`,
    size: statSync(zip).size,
    notes: notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8').trim() : '',
    stackVersion: pinnedStackVersion(readFileSync('src/shared/assistantStackConstants.ts', 'utf8')),
    pubDate: new Date().toISOString(),
  };
  const feed = buildFeed({ ...release, channel, sha256: await hashFile(zip, 'sha256', 'hex') });
  const channelFile = buildChannelFile({
    ...release,
    sha512: await hashFile(zip, 'sha512', 'base64'),
  });
  writeFileSync(out, `${JSON.stringify(feed, null, 2)}\n`);
  writeFileSync(channelOut, `${JSON.stringify(channelFile, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
