/**
 * Renders sheets and panels in headless Chromium, in both themes: the Settings sheet's Updates
 * panel in several update states, the Circle form sheets, and the Circle and project inspectors. Fails on
 * spacing the design system rules out:
 *
 * - a button that isn't 34px or 28px tall (--control-height, --control-height-sm)
 * - content in an inspector pane closer than 8px to the pane's left or right edge
 * - two stacked blocks in a sheet or field closer than 4px (a label on its input, a field on
 *   the buttons below it)
 * - rows in a section closer than --space-2 (8px)
 * - a section heading closer than 16px to the content above it
 * - a row whose label and hint column is narrower than 200px
 * - anything that passes the right edge of its sheet, panel or settings row without a scroll
 *   container (.wb-scroll-x) to hold it
 *
 * Run with `bun run check:sheet-layout`; screenshots land in a temp folder it prints.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(path.join(tmpdir(), 'sheet-layout-'));
const PAGES = [
  ...['up-to-date', 'available', 'waiting', 'blocked'].map((state) => `view=updates&state=${state}`),
  'view=access',
  'view=browser',
  'view=circle-start',
  'view=circle-join',
  'view=channel-add',
  'view=circle-tab',
  'view=circle-person',
  'view=call-check',
  'view=callouts',
  'view=buttons',
  'view=project',
  'view=project-empty',
];
/** Window widths: the default, and a narrow window where wide content must scroll. The
 *  inspector only shows from 1280px, so its views run at the default alone. */
const WIDTHS = [1400, 900];
const INSPECTOR_VIEWS = ['view=circle-tab', 'view=circle-person', 'view=project', 'view=project-empty'];
const widths = (query) => (INSPECTOR_VIEWS.includes(query) ? [1400] : WIDTHS);

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  plugins: [react(), tailwindcss()],
  define: { __BOUNDARY_APP_NAME__: '"Boundary"', __BOUNDARY_INSTANCE__: '""', global: 'globalThis' },
  build: { outDir: path.join(outDir, 'site'), emptyOutDir: true },
});
const server = await preview({ root, configFile: false, logLevel: 'warn', build: { outDir: path.join(outDir, 'site') }, preview: { port: 0 } });
const url = server.resolvedUrls.local[0];

/** Runs in the page; returns one line per problem. */
const measure = () => {
  const problems = [];
  const box = (el) => el.getBoundingClientRect();
  const name = (el) =>
    (el.matches('label, p, h2') ? el.textContent : el.querySelector('.wb-settings-label, label, h2')?.textContent ?? el.tagName.toLowerCase() + '.' + el.className)
      .trim()
      .slice(0, 40);
  const visible = (el) => box(el).height > 0 && getComputedStyle(el).position !== 'absolute';
  for (const stack of document.querySelectorAll('.wb-sheet, .wb-field, .wb-settings-sheet-body')) {
    const blocks = [...stack.children].filter(visible);
    for (let i = 1; i < blocks.length; i += 1) {
      const above = box(blocks[i - 1]);
      const below = box(blocks[i]);
      if (below.top < above.bottom - 1) continue; // side by side, not stacked
      const gap = below.top - above.bottom;
      if (gap < 3.5) problems.push(`"${name(blocks[i - 1])}" and "${name(blocks[i])}" are ${gap.toFixed(1)}px apart`);
    }
  }
  for (const stack of document.querySelectorAll('.wb-settings-rows')) {
    const rows = [...stack.children];
    for (let i = 1; i < rows.length; i += 1) {
      const gap = box(rows[i]).top - box(rows[i - 1]).bottom;
      if (gap < 7.5) problems.push(`rows "${name(rows[i - 1])}" and "${name(rows[i])}" are ${gap.toFixed(1)}px apart`);
    }
  }
  for (const heading of document.querySelectorAll('.wb-settings-section > h2')) {
    const above = heading.parentElement.previousElementSibling;
    if (!above) continue;
    const gap = box(heading).top - box(above).bottom;
    if (gap < 15.5) problems.push(`heading "${heading.textContent}" is ${gap.toFixed(1)}px below the content above`);
  }
  for (const pane of document.querySelectorAll('.wb-insp-pane')) {
    const edges = box(pane);
    for (const el of pane.querySelectorAll('*')) {
      const at = box(el);
      if (at.width === 0 || at.height === 0) continue;
      // Where the content starts: a full-width block that pads its own content is fine.
      const style = getComputedStyle(el);
      const left = at.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      const right = at.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      const inset = Math.min(left - edges.left, edges.right - right);
      if (inset < 7.5) {
        problems.push(`"${name(el)}" is ${inset.toFixed(1)}px from the inspector's edge`);
        break;
      }
    }
  }
  for (const row of document.querySelectorAll('.wb-settings-row')) {
    const copy = row.querySelector(':scope > :first-child');
    if (copy?.querySelector('.wb-settings-label') && box(copy).width < 200) {
      problems.push(`row "${name(row)}" has a ${Math.round(box(copy).width)}px label column`);
    }
  }
  const scrolls = (el, stop) => {
    for (let up = el.parentElement; up && up !== stop; up = up.parentElement) {
      if (getComputedStyle(up).overflowX !== 'visible') return true;
    }
    return false;
  };
  for (const frame of document.querySelectorAll('.wb-sheet, .wb-insp-pane, .wb-settings-sheet-body, .wb-settings-row')) {
    const edge = box(frame).right;
    for (const el of frame.querySelectorAll('*')) {
      if (box(el).right > edge + 0.5 && !scrolls(el, frame)) {
        problems.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} passes the right edge of ${frame.className}`);
        break;
      }
    }
  }
  // Buttons come in the token heights: 34px, or 28px small.
  const buttons = '.wb-btn-solid, .wb-btn-ghost, .wb-btn-tiny, .wb-btn-danger, [data-slot="button"]';
  for (const button of document.querySelectorAll(buttons)) {
    const height = box(button).height;
    if (height === 0) continue;
    if (![34, 28].some((allowed) => Math.abs(height - allowed) < 0.5)) {
      problems.push(`button "${button.textContent.trim().slice(0, 30)}" is ${height.toFixed(1)}px tall`);
    }
  }
  return problems;
};

const browser = await chromium.launch();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    for (const [query, width] of PAGES.flatMap((query) => widths(query).map((width) => [query, width]))) {
      const state = `${query.replace(/view=|state=/g, '').replace('&', '-')}-${width}`;
      const page = await browser.newPage({ viewport: { width, height: 1800 } });
      page.on('pageerror', (error) => console.log(`  ${state} ${theme}: page error: ${error.message}`));
      await page.goto(`${url}?${query}&theme=${theme}`);
      await page.waitForSelector('.wb-settings-section, .wb-sheet, .wb-insp-pane');
      const problems = await page.evaluate(measure);
      const shot = path.join(outDir, `${state}-${theme}.png`);
      await page.locator('.wb-settings-sheet, .wb-sheet, .wb-right').first().screenshot({ path: shot });
      await page.close();
      console.log(`${state} ${theme}: ${problems.length ? 'FAIL' : 'ok'}`);
      for (const line of problems) console.log(`  ${line}`);
      if (problems.length) failed = true;
    }
  }
} finally {
  await browser.close();
  server.httpServer.close();
}
console.log(`Screenshots: ${outDir}`);
process.exitCode = failed ? 1 : 0;
