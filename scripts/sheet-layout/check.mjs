/**
 * Renders sheets and panels in headless Chromium, in both themes: the Settings sheet's Updates
 * panel in several update states, the Circle form sheets, the Circle and project inspectors, and the
 * choice controls (Checkbox, Radio, Switch, ChoiceRow, ChoiceGroup), toggles (Segmented, Chip,
 * ChipGroup), Tabs, and Menu and Listbox. Fails on
 * spacing the design system rules out:
 *
 * - a button that isn't 34px or 28px tall (--control-height, --control-height-sm), except an
 *   icon-xs Button at 24px (--control-height-xs); an icon Button that isn't square
 * - a checkbox or radio that isn't 16×16 (--choice-size), or a switch that isn't 32×18
 *   (--switch-width, --switch-height), in any view
 * - a segmented control that isn't 34px tall, or 28px with data-size="sm", or a chip that isn't 28px, in any view
 * - a menu item or listbox option shorter than 28px (--control-height-sm), in any view
 * - a tab that isn't 34px tall, outside a header bar (TabsList variant="bar"), in any view
 * - a text field, select or select trigger that isn't 34px or 28px tall
 * - an invalid control (aria-invalid) whose border isn't --danger, focused or not
 * - a disabled ChoiceRow that doesn't dim to 0.5 once, with its control left at full opacity
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
  'view=choices',
  'view=fields',
  'view=toggles',
  'view=menus',
  'view=icon-buttons',
  'view=tabs',
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
  // The harness bundles no release notes; the alias still has to resolve (ADR 0059).
  resolve: { alias: { '@release-notes': path.resolve(root, '..', '..', 'src', 'release-notes-empty') } },
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
    const name = (button.textContent.trim() || button.getAttribute('aria-label') || '').slice(0, 30);
    const heights = button.dataset.size === 'icon-xs' ? [24] : [34, 28];
    if (!heights.some((allowed) => Math.abs(height - allowed) < 0.5)) {
      problems.push(`button "${name}" is ${height.toFixed(1)}px tall`);
    }
    if (button.dataset.size?.startsWith('icon') && Math.abs(box(button).width - height) > 0.5) {
      problems.push(`icon button "${name}" is ${box(button).width.toFixed(1)}×${height.toFixed(1)}px, not square`);
    }
  }
  // Text fields and selects come in the token heights too.
  const controlName = (el) =>
    (el.getAttribute('aria-label') ?? (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) ?? el.tagName.toLowerCase())
      .trim()
      .slice(0, 30);
  const controls = "input:not([type=checkbox], [type=radio], [type=range], [type=hidden]), select, [data-slot='select-trigger']";
  for (const control of document.querySelectorAll(controls)) {
    const height = box(control).height;
    if (height === 0) continue;
    if (![34, 28].some((allowed) => Math.abs(height - allowed) < 0.5)) {
      problems.push(`control "${controlName(control)}" is ${height.toFixed(1)}px tall`);
    }
  }
  // A segmented track is 34px, or 28px small; a chip is 28px.
  for (const track of document.querySelectorAll("[data-slot='segmented']")) {
    const height = box(track).height;
    if (height === 0) continue;
    const expected = track.dataset.size === 'sm' ? 28 : 34;
    if (Math.abs(height - expected) > 0.5) {
      problems.push(`segmented "${track.getAttribute('aria-label') ?? ''}" is ${height.toFixed(1)}px`);
    }
  }
  for (const chip of document.querySelectorAll("[data-slot='chip']")) {
    const height = box(chip).height;
    if (height === 0) continue;
    if (Math.abs(height - 28) > 0.5) problems.push(`chip "${chip.textContent.trim()}" is ${height.toFixed(1)}px`);
  }
  // A menu row is at least 28px; a description may make it taller.
  for (const row of document.querySelectorAll("[data-slot='menu-item'], [data-slot='listbox-option']")) {
    const height = box(row).height;
    if (height === 0) continue;
    if (height < 27.5) problems.push(`menu row "${row.textContent.trim().slice(0, 30)}" is ${height.toFixed(1)}px`);
  }
  // A tab is 34px, except in a header bar, where it takes the bar's height.
  for (const tab of document.querySelectorAll("[data-slot='tabs-list']:not([data-variant='bar']) > [data-slot='tabs-trigger']")) {
    const height = box(tab).height;
    if (height === 0) continue;
    if (Math.abs(height - 34) > 0.5) problems.push(`tab "${tab.textContent.trim()}" is ${height.toFixed(1)}px`);
  }
  // An invalid control keeps its --danger border, focused or not.
  const probe = document.createElement('i');
  probe.style.color = 'var(--danger)';
  document.body.append(probe);
  const danger = getComputedStyle(probe).color;
  probe.remove();
  for (const control of document.querySelectorAll("[data-slot][aria-invalid='true']")) {
    const border = getComputedStyle(control).borderTopColor;
    if (border !== danger) problems.push(`invalid control "${controlName(control)}" has border ${border}, not ${danger}`);
  }
  // Choice controls come in one size each: 16×16 boxes, 32×18 switches.
  const label = (el) => (el.getAttribute('aria-label') ?? el.closest('label')?.textContent ?? el.tagName.toLowerCase()).trim().slice(0, 30);
  const sized = (selector, width, height, kind) => {
    for (const el of document.querySelectorAll(selector)) {
      const at = box(el);
      if (at.width === 0 && at.height === 0) continue;
      if (Math.abs(at.width - width) > 0.5 || Math.abs(at.height - height) > 0.5) {
        problems.push(`${kind} "${label(el)}" is ${at.width.toFixed(1)}×${at.height.toFixed(1)}px`);
      }
    }
  };
  sized('input[type=checkbox], input[type=radio]', 16, 16, 'choice');
  sized('[role=switch]', 32, 18, 'switch');
  // A disabled row dims once: the row to 0.5, its control left at 1.
  for (const row of document.querySelectorAll("[data-slot='choice-row']")) {
    const control = row.querySelector("[data-slot='choice-row-control'] > *");
    if (!control?.matches(':disabled')) continue;
    const rowOpacity = Number(getComputedStyle(row).opacity);
    const controlOpacity = Number(getComputedStyle(control).opacity);
    if (Math.abs(rowOpacity - 0.5) > 0.01 || controlOpacity !== 1) {
      problems.push(`disabled row "${label(control)}" has opacity ${rowOpacity}, its control ${controlOpacity}`);
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
