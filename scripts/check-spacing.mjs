/**
 * Spacing and selector drift in product CSS (design system rule: no raw values outside
 * tokens.css). Fails when a stylesheet has more raw padding, margin or gap lengths, or more
 * selectors defined in two top-level blocks, than `allow` below records for it.
 *
 * The counts may only go down. When a change removes some, the check fails until the entry is
 * lowered to the new count, so the drop is kept. New CSS uses `--space-*` tokens and adds to an
 * existing block instead of opening a second one.
 *
 *   node scripts/check-spacing.mjs            check every stylesheet
 *   node scripts/check-spacing.mjs --list F   print each raw value and duplicate in F
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { scanCss } from './css-spacing.mjs';

/** @type {Record<string, { spacing: number; duplicates: number }>} */
const allow = {
  'src/renderer/product/chat/circle/circleChat.css': { spacing: 9, duplicates: 0 },
  'src/renderer/product/chat/workbench.css': { spacing: 120, duplicates: 9 },
  'src/renderer/product/inference/inference.css': { spacing: 21, duplicates: 0 },
  'src/renderer/product/resources.css': { spacing: 9, duplicates: 0 },
  'src/renderer/product/startup/startup.css': { spacing: 1, duplicates: 0 },
};

/** Tokens are where raw values belong. */
const skip = new Set(['src/renderer/styles/tokens.css']);

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** Private experiments keep their own entries, in the same form, beside their code. */
const experimentAllowances = join(root, 'src', 'experiments', 'drift-allowances.json');
if (existsSync(experimentAllowances)) {
  Object.assign(allow, JSON.parse(readFileSync(experimentAllowances, 'utf8')).spacing ?? {});
}

/** @param {string} dir @returns {string[]} */
function stylesheets(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : stylesheets(path);
    return entry.name.endsWith('.css') ? [relative(root, path)] : [];
  });
}

const listIndex = process.argv.indexOf('--list');
if (listIndex >= 0) {
  const file = process.argv[listIndex + 1];
  const { spacing, duplicates } = scanCss(readFileSync(resolve(root, file), 'utf8'));
  for (const item of spacing) console.log(`${file}:${item.line}  ${item.property}: ${item.value}`);
  for (const item of duplicates) console.log(`${file}:${item.lines.join(',')}  ${item.selector} (${item.lines.length} blocks)`);
  process.exit(0);
}

const problems = [];
let spacingTotal = 0;
let duplicateTotal = 0;
const seen = new Set();
for (const file of stylesheets(join(root, 'src')).sort()) {
  if (skip.has(file)) continue;
  seen.add(file);
  const { spacing, duplicates } = scanCss(readFileSync(join(root, file), 'utf8'));
  const limit = allow[file] ?? { spacing: 0, duplicates: 0 };
  spacingTotal += spacing.length;
  duplicateTotal += duplicates.length;
  const compare = (kind, count, allowed, fix) => {
    if (count > allowed) problems.push(`  ${file}: ${count} ${kind}, allowance ${allowed}. ${fix}`);
    if (count < allowed) problems.push(`  ${file}: ${count} ${kind}, allowance ${allowed}. Lower the allowance to ${count}.`);
  };
  compare('raw spacing values', spacing.length, limit.spacing, 'Use --space-* tokens.');
  compare('selectors with two blocks', duplicates.length, limit.duplicates, 'Merge them into one block.');
}
for (const file of Object.keys(allow)) {
  if (!seen.has(file)) problems.push(`  ${file}: has an allowance but no stylesheet. Remove the entry.`);
}

console.log(`${spacingTotal} raw spacing values and ${duplicateTotal} selectors with two blocks.`);
if (problems.length > 0) {
  console.error('Spacing allowances out of date:');
  for (const line of problems) console.error(line);
  console.error('List one file with: node scripts/check-spacing.mjs --list <file>');
  process.exitCode = 1;
}
