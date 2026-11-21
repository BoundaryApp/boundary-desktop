/**
 * Imports between source areas (see scripts/import-areas.mjs for what an area is). Fails on:
 *
 * - an import from one area into another that `allow` below does not list,
 * - an entry in `allow` that no import uses any more, so the list only shrinks,
 * - an import that crosses a process line: main and renderer, preload into either, shared into
 *   anything else, or into an experiment from outside it. These have no allowance,
 * - a file reachable from a process entry in `closedEntries` that sits outside the entry's area,
 * - an import by a host client (`hostClients`) into a core area (`coreAreas`) that doesn't go
 *   through a host file (`src/main/host/`, `src/renderer/host/`, `src/preloadExperiments.ts`,
 *   `src/preloadHost.ts`) and isn't a named exception in `hostExceptions`, and an exception no
 *   import uses any more,
 * - an import into an area that declares `entries`, of a file that isn't one of them.
 *
 * Test files are not checked. A new edge is a design decision: add it to `allow` in the same
 * change and say why in the commit, or route the import through `shared` or an existing seam.
 *
 *   node scripts/check-imports.mjs                 check
 *   node scripts/check-imports.mjs --list 'a -> b' print the imports behind one edge
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alwaysAllowed,
  areaOf,
  entryViolations,
  forbiddenReason,
  hostViolations,
  importGraph,
  leavesArea,
} from './import-areas.mjs';

/** Edges between areas as of 2026-11-20. Remove entries as they go; add one only on purpose. */
const allow = new Set([
  'main:addons -> main:assistant',
  'main:addons -> main:containerRuntime',
  'main:addons -> main:core',
  'main:addons -> main:hostBridge',
  'main:addons -> main:resources',
  'main:addons -> main:services-root',
  'main:addons -> main:stackHost',
  'main:assistant -> main:addons',
  'main:assistant -> main:circles',
  'main:assistant -> main:containerRuntime',
  'main:assistant -> main:core',
  'main:assistant -> main:hostBridge',
  'main:assistant -> main:inference',
  'main:assistant -> main:onboarding',
  'main:assistant -> main:secrets',
  'main:assistant -> main:services-root',
  'main:assistant -> main:stackHost',
  'main:bugReport -> main:assistant',
  'main:bugReport -> main:core',
  'main:bugReport -> main:hostBridge',
  'main:bugReport -> main:inference',
  'main:bugReport -> main:onboarding',
  'main:bugReport -> main:secrets',
  'main:bugReport -> main:services-root',
  'main:bugReport -> main:stackHost',
  'main:bugReport -> main:updates',
  'main:capability -> main:assistant',
  'main:capability -> main:containerRuntime',
  'main:capability -> main:core',
  'main:capability -> main:services-root',
  'main:circleSharing -> main:addons',
  'main:circleSharing -> main:assistant',
  'main:circleSharing -> main:circles',
  'main:circleSharing -> main:hostBridge',
  'main:circleSharing -> main:onboarding',
  'main:circleSharing -> main:stackHost',
  'main:containerRuntime -> main:addons',
  'main:containerRuntime -> main:core',
  'main:containerRuntime -> main:stackHost',
  'main:core -> main:addons',
  'main:core -> main:assistant',
  'main:core -> main:bugReport',
  'main:core -> main:capability',
  'main:core -> main:circleSharing',
  'main:core -> main:circles',
  'main:core -> main:containerRuntime',
  'main:core -> main:desktopAgent',
  'main:core -> main:hostBridge',
  'main:core -> main:inference',
  'main:core -> main:onboarding',
  'main:core -> main:resources',
  'main:core -> main:services-root',
  'main:core -> main:setup',
  'main:core -> main:updates',
  'main:core -> main:whatsNew',
  'main:desktopAgent -> main:core',
  'main:desktopAgent -> main:services-root',
  'main:hostBridge -> main:addons',
  'main:hostBridge -> main:assistant',
  'main:hostBridge -> main:circles',
  'main:hostBridge -> main:core',
  'main:hostBridge -> main:inference',
  'main:hostBridge -> main:onboarding',
  'main:hostBridge -> main:secrets',
  'main:hostBridge -> main:services-root',
  'main:hostBridge -> main:stackHost',
  'main:hostBridge -> main:updates',
  'main:inference -> main:assistant',
  'main:inference -> main:circles',
  'main:inference -> main:core',
  'main:inference -> main:hostBridge',
  'main:inference -> main:onboarding',
  'main:inference -> main:secrets',
  'main:inference -> main:stackHost',
  'main:onboarding -> main:assistant',
  'main:onboarding -> main:core',
  'main:onboarding -> main:inference',
  'main:onboarding -> main:secrets',
  'main:onboarding -> main:services-root',
  'main:resources -> main:assistant',
  'main:resources -> main:containerRuntime',
  'main:resources -> main:core',
  'main:resources -> main:onboarding',
  'main:resources -> main:services-root',
  'main:resources -> main:stackHost',
  'main:secrets -> main:core',
  'main:services-root -> main:assistant',
  'main:services-root -> main:containerRuntime',
  'main:services-root -> main:core',
  'main:services-root -> main:desktopAgent',
  'main:services-root -> main:stackHost',
  'main:setup -> main:assistant',
  'main:setup -> main:core',
  'main:setup -> main:services-root',
  'main:stackHost -> main:assistant',
  'main:updates -> main:core',
  'main:updates -> main:secrets',
  'main:updates -> main:services-root',
  'main:whatsNew -> main:assistant',
  'main:whatsNew -> main:core',
  'main:whatsNew -> main:services-root',
  'main:whatsNew -> main:updates',
  'renderer:core -> ui:chat',
  'renderer:core -> ui:circles',
  'renderer:core -> ui:shell',
  'renderer:core -> ui:startup',
  'ui:addons -> renderer:core',
  'ui:addons -> ui:calendar',
  'ui:addons -> ui:shell',
  'ui:agentButton -> renderer:core',
  'ui:agentButton -> ui:chat',
  'ui:agentButton -> ui:shell',
  'ui:agentPanel -> renderer:core',
  'ui:agentPanel -> ui:chat',
  'ui:bugReport -> ui:shell',
  'ui:calendar -> ui:shell',
  'ui:chat -> renderer:core',
  'ui:chat -> ui:addons',
  'ui:chat -> ui:circles',
  'ui:chat -> ui:inference',
  'ui:chat -> ui:shell',
  'ui:chat -> ui:writingVoices',
  'ui:circles -> renderer:core',
  'ui:circles -> ui:chat',
  'ui:circles -> ui:inference',
  'ui:circles -> ui:shell',
  'ui:components -> renderer:core',
  'ui:desktopAgent -> renderer:core',
  'ui:desktopAgent -> ui:agentButton',
  'ui:desktopAgent -> ui:agentPanel',
  'ui:desktopAgent -> ui:chat',
  'ui:desktopAgent -> ui:circles',
  'ui:desktopAgent -> ui:shell',
  'ui:inference -> renderer:core',
  'ui:inference -> ui:circles',
  'ui:inference -> ui:shell',
  'ui:services -> renderer:core',
  'ui:shell -> renderer:core',
  'ui:shell -> ui:addons',
  'ui:shell -> ui:agentButton',
  'ui:shell -> ui:bugReport',
  'ui:shell -> ui:calendar',
  'ui:shell -> ui:chat',
  'ui:shell -> ui:circles',
  'ui:shell -> ui:desktopAgent',
  'ui:shell -> ui:inference',
  'ui:shell -> ui:services',
  'ui:shell -> ui:startup',
  'ui:shell -> ui:whatsNew',
  'ui:shell -> ui:writingVoices',
  'ui:startup -> renderer:core',
  'ui:startup -> ui:shell',
  'ui:startup -> ui:whatsNew',
  'ui:writingVoices -> renderer:core',
  'ui:writingVoices -> ui:inference',
  'ui:writingVoices -> ui:shell',
]);

/**
 * Entries bundled into their own process. Everything they import, directly or not, stays in
 * the entry's area or `shared`, so the process carries no app code it doesn't own.
 */
const closedEntries = ['src/main/services/circles/networkProcess.ts', 'src/main/services/hostBridge/bridgeProcess.ts'];

/** Areas whose imports of the core must go through host files. */
const hostClients = (area) => area.startsWith('exp:') || area === 'main:circles';

/** The core app. Host clients reach these only through host files or a named exception. */
const coreAreas = new Set(['main:core', 'main:services-root', 'main:secrets', 'renderer:core', 'ui:shell', 'preload']);

/** Areas that may only be imported through these files, keyed by area. */
const entries = {};

/**
 * Host-client imports of a core file that isn't a host file, as `"<area> -> <file>"`, each kept
 * because only one feature uses the name. Experiments name theirs in drift-allowances.json.
 */
const hostExceptions = new Set();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Private experiments keep their own entries, in the same form, beside their code. */
const experimentAllowances = join(root, 'src', 'experiments', 'drift-allowances.json');
if (existsSync(experimentAllowances)) {
  const experiments = JSON.parse(readFileSync(experimentAllowances, 'utf8'));
  for (const key of experiments.imports ?? []) allow.add(key);
  for (const { edge } of experiments.hostExceptions ?? []) hostExceptions.add(edge);
}

const isTest = (name) => /\.test\.tsx?$/.test(name) || name.startsWith('vitest.');

/** @param {string} dir @returns {string[]} */
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', '__tests__', '__mocks__'].includes(entry.name) ? [] : sources(path);
    }
    return /\.tsx?$/.test(entry.name) && !isTest(entry.name) ? [relative(root, path).split('\\').join('/')] : [];
  });
}

const isFile = (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();
const { edges, imports, unresolved } = importGraph(
  sources(join(root, 'src')).sort(),
  (path) => readFileSync(join(root, path), 'utf8'),
  isFile,
);

const listIndex = process.argv.indexOf('--list');
if (listIndex >= 0) {
  for (const { from, to } of edges.get(process.argv[listIndex + 1]) ?? []) console.log(`${from}  ->  ${to}`);
  process.exit(0);
}

const problems = [];
for (const [key, found] of [...edges].sort(([a], [b]) => a.localeCompare(b))) {
  const example = `${found[0].from} imports ${found[0].to}`;
  const reason = forbiddenReason(key);
  if (reason !== null) problems.push(`  ${key}: ${reason}. ${example}`);
  else if (!alwaysAllowed(key) && !allow.has(key)) problems.push(`  ${key}: new edge (${found.length} imports, e.g. ${example}).`);
}
for (const key of allow) {
  if (!edges.has(key)) problems.push(`  ${key}: allowed but no longer imported. Remove the entry.`);
}
for (const entry of closedEntries) {
  for (const { from, to } of leavesArea(entry, imports)) {
    problems.push(`  ${entry} reaches ${to} (imported by ${from}); its process keeps to its own area.`);
  }
}
const usedExceptions = new Set();
for (const { from, to } of hostViolations(edges, hostClients, coreAreas)) {
  const exception = `${areaOf(from)} -> ${to}`;
  if (hostExceptions.has(exception)) usedExceptions.add(exception);
  else {
    problems.push(
      `  ${from} imports ${to}: use the host API (src/main/host, src/renderer/host, src/preloadExperiments.ts or src/preloadHost.ts), or add a named exception.`,
    );
  }
}
for (const exception of hostExceptions) {
  if (!usedExceptions.has(exception))
    problems.push(`  ${exception}: host exception no longer imported. Remove the exception.`);
}
for (const { from, to } of entryViolations(edges, entries)) {
  const area = areaOf(to);
  problems.push(`  ${from} imports ${to}: ${area} is only imported through its entries (${entries[area].join(', ')}).`);
}
for (const { from, specifier } of unresolved) problems.push(`  ${from}: cannot resolve '${specifier}'.`);

console.log(`${edges.size} edges between areas, ${allow.size} allowed.`);
if (problems.length > 0) {
  console.error('Import boundaries:');
  for (const line of problems) console.error(line);
  console.error("List one edge with: node scripts/check-imports.mjs --list '<a> -> <b>'");
  process.exitCode = 1;
}
