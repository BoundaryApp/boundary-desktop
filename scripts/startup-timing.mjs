/**
 * Prints where the recent launches' start-up time went, from the debug log: the time to the
 * window, each stack stage, and when each container started and turned healthy.
 *
 *   node scripts/startup-timing.mjs [--last N] [--packaged] [log path]
 *
 * Prints timings, stage names and container names and nothing else, so its output is safe to
 * share. The log holds more than that, such as error text and paths.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_LOG = join(homedir(), 'Library', 'Logs', 'Boundary', 'boundary-debug.log');

function parseArgs(argv) {
  const options = { last: 5, packagedOnly: false, logPath: DEFAULT_LOG };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--last') options.last = Number(argv[(i += 1)]);
    else if (argv[i] === '--packaged') options.packagedOnly = true;
    else options.logPath = argv[i];
  }
  return options;
}

function readSessions(logPath) {
  const sessions = new Map();
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessions.has(entry.sessionId)) sessions.set(entry.sessionId, []);
    sessions.get(entry.sessionId).push(entry);
  }
  return [...sessions.values()];
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const isPackaged = (entries) =>
  entries.some((entry) => entry.message === 'app ready entered' && entry.data?.isPackaged);

function printSession(entries) {
  const at = (message) => entries.find((entry) => entry.message === message);
  const boot = at('main module boot');
  const shown = at('ready-to-show');
  const version = at('app ready entered')?.data?.version ?? 'unknown version';
  const packaged = isPackaged(entries) ? 'packaged' : 'dev';
  console.log(`\n${entries[0].ts.slice(0, 19)}  ${version}  ${packaged}`);
  if (boot && shown) {
    console.log(`  window shown after ${seconds(Date.parse(shown.ts) - Date.parse(boot.ts))}`);
  }
  for (const entry of entries) {
    if (entry.message === 'start-up stage finished') {
      const { stage, next, ms, firstRun } = entry.data;
      console.log(`  ${stage} > ${next}: ${seconds(ms)}${firstRun ? ' (first run)' : ''}`);
    }
    if (entry.message === 'compose finished' && entry.data.args?.includes('up')) {
      printCompose(entry.data);
    }
    if (entry.message === 'start-up milestones') {
      console.log(`  milestones (${entry.data.kind}):`);
      for (const [milestone, ms] of Object.entries(entry.data.reached)) {
        console.log(`    ${milestone.padEnd(30)} ${seconds(ms).padStart(7)}`);
      }
    }
  }
}

function printCompose({ ms, services }) {
  console.log(`  compose up: ${seconds(ms)}`);
  // A long run's data is stored as truncated text, which has no per-container timings.
  if (typeof services !== 'object' || services === null) return;
  const rows = Object.entries(services)
    .map(([container, { steps, lastMs }]) => ({
      container,
      started: steps.Started,
      healthy: steps.Healthy,
      lastMs,
    }))
    .sort((a, b) => a.lastMs - b.lastMs);
  for (const { container, started, healthy, lastMs } of rows) {
    const startedText = started === undefined ? '-' : seconds(started);
    const healthyText = healthy === undefined ? '-' : seconds(healthy);
    console.log(
      `    ${container.padEnd(30)} started ${startedText.padStart(7)}  healthy ${healthyText.padStart(7)}  last ${seconds(lastMs).padStart(7)}`
    );
  }
}

const { last, packagedOnly, logPath } = parseArgs(process.argv.slice(2));
const sessions = readSessions(logPath).filter((entries) => !packagedOnly || isPackaged(entries));
for (const entries of sessions.slice(-last)) printSession(entries);
