/**
 * `bun run check`: every step Test Build runs, in two stages. The first stage runs type
 * checking, lint and the static checks at the same time; the second runs the unit tests alone,
 * since vitest already uses every core. Every step runs even when an earlier one fails, so one
 * run reports all failures.
 *
 * Each step's output is printed when it finishes, then a table of times. Exits 1 when any
 * step failed.
 *
 *   node scripts/check.mjs
 */
import { spawn } from 'node:child_process';

/** Script names refer to package.json, so Test Build and this run the same commands. */
const stages = [
  [
    { name: 'check:release-notes', cmd: ['bun', 'run', 'check:release-notes'] },
    // `type-check` as two parallel steps.
    { name: 'tsc (src and tests)', cmd: ['bunx', 'tsc', '-p', 'tsconfig.test.json'] },
    { name: 'tsc (tooling)', cmd: ['bunx', 'tsc', '-p', 'tsconfig.tooling.json'] },
    // `lint` on several threads. Test Build runs it on one, within the runner's memory.
    { name: 'lint', cmd: ['bunx', 'eslint', '--concurrency', 'auto', '.'] },
    { name: 'check:unused', cmd: ['bun', 'run', 'check:unused'] },
    { name: 'check:duplicates', cmd: ['bun', 'run', 'check:duplicates'] },
    { name: 'check:spacing', cmd: ['bun', 'run', 'check:spacing'] },
    { name: 'check:imports', cmd: ['bun', 'run', 'check:imports'] },
    { name: 'check:stack-archive', cmd: ['bun', 'run', 'check:stack-archive'] },
  ],
  [{ name: 'test', cmd: ['bun', 'run', 'test'] }],
];

function run(step) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(step.cmd[0], step.cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    let finished = false;
    // A spawn failure emits 'error' and then 'close'; report the first.
    const finish = (code, error) => {
      if (finished) return;
      finished = true;
      const seconds = (performance.now() - started) / 1000;
      const output = Buffer.concat(chunks).toString() + (error ? `${error.message}\n` : '');
      process.stdout.write(`\n── ${step.name} (${seconds.toFixed(1)}s${code === 0 ? '' : `, exit ${code}`})\n`);
      process.stdout.write(output.endsWith('\n') || output === '' ? output : `${output}\n`);
      resolve({ name: step.name, code, seconds });
    };
    child.on('error', (error) => finish(127, error));
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
  });
}

const results = [];
for (const stage of stages) {
  results.push(...(await Promise.all(stage.map(run))));
}

const width = Math.max(...results.map((r) => r.name.length));
process.stdout.write('\n');
for (const r of results) {
  process.stdout.write(`${r.name.padEnd(width)}  ${r.seconds.toFixed(1).padStart(6)}s  ${r.code === 0 ? 'ok' : `FAILED (exit ${r.code})`}\n`);
}
const failed = results.filter((r) => r.code !== 0);
process.stdout.write(failed.length ? `check: ${failed.length} of ${results.length} failed\n` : `check: all ${results.length} passed\n`);
process.exitCode = failed.length ? 1 : 0;
