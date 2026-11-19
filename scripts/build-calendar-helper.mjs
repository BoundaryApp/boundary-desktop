/**
 * Builds the Swift calendar helper (native/calendar-helper) and copies it to
 * resources/calendar-helper/boundary-calendar-helper, where dev runs and Forge's packaging look.
 * macOS only; other platforms exit 0 without building.
 *
 *   --universal         arm64 and x86_64 in one binary (needs the full Xcode toolchain)
 *   --app-id <id>       bundle id of the app; the helper's embedded id is "<id>.calendar-helper"
 *   --usage-text <txt>  calendar usage text for the embedded Info.plist
 *
 * Without --app-id and --usage-text the checked-in Info.plist is embedded. Without --universal the
 * binary is built for this Mac's architecture.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = join(root, 'native', 'calendar-helper');
const outDir = join(root, 'resources', 'calendar-helper');
const binaryName = 'boundary-calendar-helper';

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function xmlEscape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The checked-in Info.plist with the app's bundle id and usage text swapped in. */
function infoPlistFor(appId, usageText) {
  let plist = readFileSync(join(packagePath, 'Info.plist'), 'utf8');
  if (appId) {
    plist = plist.replace(
      /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*/,
      `$1${xmlEscape(appId)}.calendar-helper`
    );
  }
  if (usageText) {
    plist = plist.replace(
      /(<key>NSCalendars(?:FullAccess)?UsageDescription<\/key>\s*<string>)[^<]*/g,
      `$1${xmlEscape(usageText)}`
    );
  }
  return plist;
}

if (process.platform !== 'darwin') {
  console.log('[calendar-helper] skipped: the helper is built on macOS only');
  process.exit(0);
}

const archFlags = process.argv.includes('--universal') ? ['--arch', 'arm64', '--arch', 'x86_64'] : [];
const scratch = mkdtempSync(join(tmpdir(), 'calendar-helper-'));
try {
  const env = { ...process.env };
  if (option('--app-id') || option('--usage-text')) {
    const plistPath = join(scratch, 'Info.plist');
    writeFileSync(plistPath, infoPlistFor(option('--app-id'), option('--usage-text')));
    env.BOUNDARY_CALENDAR_HELPER_PLIST = plistPath;
  } else {
    delete env.BOUNDARY_CALENDAR_HELPER_PLIST;
  }
  const swiftArgs = ['build', '-c', 'release', '--package-path', packagePath, ...archFlags];
  execFileSync('swift', swiftArgs, { stdio: 'inherit', env });
  const binPath = execFileSync('swift', [...swiftArgs, '--show-bin-path'], {
    env,
    encoding: 'utf8',
  }).trim();
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(binPath, binaryName), join(outDir, binaryName));
  console.log(`[calendar-helper] ${join(outDir, binaryName)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
