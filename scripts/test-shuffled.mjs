/**
 * The unit suite in random order: files, and the tests in each file, are shuffled from one
 * seed. A test that passes in the usual order and fails here depends on what an earlier test
 * left behind. The seed is printed first; `SEED=<n> bun run test:shuffle` repeats that order.
 * Extra arguments go to vitest, e.g. a file to repeat only its order.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const vitestPackage = require.resolve('vitest/package.json');
const vitestBin = join(dirname(vitestPackage), JSON.parse(readFileSync(vitestPackage, 'utf8')).bin.vitest);

// An empty SEED (a scheduled CI run passes one) means a new order, as an unset one does.
const seed = process.env.SEED || String(Math.floor(Math.random() * 2 ** 31));
if (!/^\d+$/.test(seed)) {
  console.error(`SEED must be a whole number, not "${seed}".`);
  process.exit(2);
}
console.log(`Shuffled run, seed ${seed}. Repeat this order with: SEED=${seed} bun run test:shuffle`);

const run = spawnSync(
  process.execPath,
  [vitestBin, 'run', '--sequence.shuffle', '--sequence.seed', seed, ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' }
);
if (run.status !== 0) console.log(`Failed with seed ${seed}. Repeat it with: SEED=${seed} bun run test:shuffle`);
process.exit(run.status ?? 1);
