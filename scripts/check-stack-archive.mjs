/**
 * Downloads the pinned agent stack zip and the pinned release tarball, and compares each with
 * its pinned checksum (SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256, SOVEREIGN_AGENT_STACK_RELEASE_SHA256).
 * A hash left behind by a pin change passes every offline check, then refuses the download on
 * every install and upgrade. Needs network access.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const constantsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/shared/assistantStackConstants.ts'
);
const constants = readFileSync(constantsPath, 'utf8');

function constant(name) {
  const match = constants.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  if (!match) {
    console.error(`check-stack-archive: ${name} not found in ${constantsPath}`);
    process.exit(1);
  }
  return match[1];
}

async function check(url, expected) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`check-stack-archive: ${url} answered ${response.status}`);
    process.exit(1);
  }
  const actual = createHash('sha256')
    .update(Buffer.from(await response.arrayBuffer()))
    .digest('hex');
  if (actual !== expected) {
    console.error(`check-stack-archive: ${url}\n  pinned ${expected}\n  actual ${actual}`);
    process.exit(1);
  }
}

const ref = constant('SOVEREIGN_AGENT_STACK_REF');
const version = constant('SOVEREIGN_AGENT_STACK_VERSION');
const repo = 'https://github.com/kaxline/sovereign-agent-stack';
await check(`${repo}/archive/${ref}.zip`, constant('SOVEREIGN_AGENT_STACK_ARCHIVE_SHA256'));
await check(
  `${repo}/releases/download/${version}/sovereign-agent-stack-${version}.tar.gz`,
  constant('SOVEREIGN_AGENT_STACK_RELEASE_SHA256')
);
console.log(`Stack archive (${ref.slice(0, 7)}) and release tarball (${version}) match their pinned checksums.`);
