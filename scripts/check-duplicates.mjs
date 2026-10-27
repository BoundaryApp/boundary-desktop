/**
 * Repeated blocks (ADR 0031 §4). Runs jscpd with .jscpd.json, then fails on any clone that
 * `allow` below does not cover, and on any `allow` entry that covers no clone.
 *
 * An entry covers every clone between its two files (one file for a clone inside a file). The
 * list may only shrink: remove an entry when its clones go, and share the code of a new clone
 * instead of adding an entry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** @type {Array<{ files: [string] | [string, string]; reason: string }>} */
const allow = [
  {
    files: ['src/main/services/assistant/calendar/calendarService.ts'],
    reason: 'The test, connect and replace-password handlers check the same fields and report a partial save the same way, with different steps between.',
  },
  {
    files: ['src/main/services/assistant/hermes/hermesChatSessions.ts'],
    reason: 'startHermesChatStream replaces an unsaved DM with a new session in two branches that drop different ids and title it differently.',
  },
  {
    files: ['src/main/services/assistant/hermes/hermesProjects.ts'],
    reason: 'Project actions end by activating on the gateway and listing projects, varying in the connecting flag and when the id is written; two check the host folder the same way.',
  },
  {
    files: ['src/main/services/onboarding/OpenAiOnboardingStore.ts'],
    reason: 'Each connection kind’s save repeats the encryption check and the status reply around a different write.',
  },
  {
    files: ['src/renderer/product/chat/AllChatsPane.tsx', 'src/renderer/product/chat/ChatRail.tsx'],
    reason: 'One list icon drawn at 20px with a 1.4 stroke and at 16px with a 1.5 stroke.',
  },
  {
    files: ['src/renderer/product/chat/ChannelSheets.tsx'],
    reason: 'The new room, make channel and rename sheets repeat the name and slug fields and their state.',
  },
  {
    files: ['src/renderer/product/chat/EmptyProjectSheet.tsx', 'src/renderer/product/chat/NewProjectSheet.tsx'],
    reason: 'Both new-project sheets repeat the Create and Cancel actions and the name field.',
  },
];

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Private experiments keep their own entries, in the same form, beside their code. */
const experimentAllowances = join(root, 'src', 'experiments', 'drift-allowances.json');
if (existsSync(experimentAllowances)) {
  allow.push(...(JSON.parse(readFileSync(experimentAllowances, 'utf8')).jscpd ?? []));
}

const require = createRequire(import.meta.url);
const jscpdPackage = require.resolve('jscpd/package.json');
const jscpdBin = join(dirname(jscpdPackage), JSON.parse(readFileSync(jscpdPackage, 'utf8')).bin.jscpd);

const out = mkdtempSync(join(tmpdir(), 'jscpd-'));
try {
  const run = spawnSync(
    process.execPath,
    [jscpdBin, '--reporters', 'json', '--output', out, '--absolute', '--no-tips', '--no-colors'],
    // Its stdout only names the temporary report; errors go to stderr.
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  if (run.status !== 0) process.exit(run.status ?? 1);
  const report = JSON.parse(readFileSync(join(out, 'jscpd-report.json'), 'utf8'));
  process.exitCode = check(report.duplicates);
} finally {
  rmSync(out, { recursive: true, force: true });
}

function check(clones) {
  const key = (files) => [...new Set(files)].sort().join('  ');
  const allowed = new Map(allow.map((entry) => [key(entry.files), 0]));
  const fresh = [];
  for (const clone of clones) {
    const a = clone.firstFile;
    const b = clone.secondFile;
    const files = [relative(root, a.name), relative(root, b.name)];
    const k = key(files);
    if (allowed.has(k)) {
      allowed.set(k, allowed.get(k) + 1);
      continue;
    }
    fresh.push(`  ${files[0]}:${a.start}-${a.end}  ${files[1]}:${b.start}-${b.end}  (${clone.lines} lines)`);
  }
  const stale = [...allowed].filter(([, count]) => count === 0).map(([k]) => `  ${k}`);
  const covered = clones.length - fresh.length;
  console.log(`${clones.length} repeated blocks, ${covered} covered by allowances.`);
  if (fresh.length > 0) {
    console.error(`Repeated blocks not in the allowance list (${fresh.length}); share the code:`);
    for (const line of fresh) console.error(line);
  }
  if (stale.length > 0) {
    console.error(`Allowances that match no repeated block; remove them (${stale.length}):`);
    for (const line of stale) console.error(line);
  }
  return fresh.length > 0 || stale.length > 0 ? 1 : 0;
}
