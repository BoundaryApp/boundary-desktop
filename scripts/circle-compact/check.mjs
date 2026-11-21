/**
 * Circle chats spec phase 7: renders the compact Circle thread at 320px in headless Chromium,
 * in the dark and light themes, and fails if anything scrolls sideways, if a message's hover
 * toolbar covers the next message, or if your own bubble loses contrast with the page. Run with
 * `bun run check:circle-compact`; screenshots land in a temp folder it prints.
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
const outDir = mkdtempSync(path.join(tmpdir(), 'circle-compact-'));
const WIDTH = 320;

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  // The harness bundles no release notes; the alias still has to resolve (ADR 0059).
  resolve: { alias: { '@release-notes': path.resolve(root, '..', '..', 'src', 'release-notes-empty') } },
  plugins: [react(), tailwindcss()],
  define: { __BOUNDARY_APP_NAME__: '""', __BOUNDARY_INSTANCE__: '""', global: 'globalThis' },
  build: { outDir: path.join(outDir, 'site'), emptyOutDir: true },
});
const server = await preview({ root, configFile: false, logLevel: 'warn', build: { outDir: path.join(outDir, 'site') }, preview: { port: 0 } });
const url = server.resolvedUrls.local[0];

/**
 * Whether the page scrolls sideways, and the elements that pass the viewport's right edge with
 * no ancestor clipping them (a code block or a truncated title scrolls or clips inside itself).
 */
const overflow = () => {
  const width = document.documentElement.clientWidth;
  const clipped = (el) => {
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      if (getComputedStyle(up).overflowX !== 'visible') return true;
    }
    return false;
  };
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > width + 0.5 && !clipped(el))
    .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} (${Math.round(el.getBoundingClientRect().right)}px)`);
  return { scrolls: document.documentElement.scrollWidth > width, wide: [...new Set(wide)].slice(0, 10) };
};

/**
 * For a hovered message line: null when its toolbar shows, stays inside the line's width and
 * clears the next message's line, else what's wrong. The toolbar may overlap the line above.
 */
const toolbarProblem = (line) => {
  const bar = line.querySelector(':scope > .wb-circle-bar');
  if (!bar) return null;
  if (getComputedStyle(bar).opacity !== '1') return 'not shown on hover';
  const b = bar.getBoundingClientRect();
  const l = line.getBoundingClientRect();
  if (b.left < l.left - 0.5 || b.right > l.right + 0.5) return 'passes the line sideways';
  const lines = [...document.querySelectorAll('.wb-circle-line')];
  const next = lines[lines.indexOf(line) + 1];
  if (next && b.bottom > next.getBoundingClientRect().top + 0.5) return 'covers the next message';
  return null;
};

/**
 * Every reaction pill row's pills must sit inside the thread horizontally, and each pill's text
 * must reach 4.5:1 against what shows behind it: the pill's own fill (transparent, or tinted when
 * it's yours) blended over the backgrounds under it.
 */
const pillProblems = () => {
  const thread = document.querySelector('.wb-circle-thread').getBoundingClientRect();
  const rgb = (value) => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const parts = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    probe.remove();
    return parts.slice(0, 3);
  };
  /** The color behind an element's text: its background and its ancestors', blended from the
   *  first opaque one up. */
  const backdrop = (el) => {
    const layers = [];
    for (let up = el; up; up = up.parentElement) {
      const [r, g, b, a = 1] = getComputedStyle(up).backgroundColor.match(/[\d.]+/g).map(Number);
      if (a > 0) layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    return layers.reduceRight(
      (under, [r, g, b, a]) => [r, g, b].map((c, i) => c * a + under[i] * (1 - a)),
      rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg') || 'white')
    );
  };
  const lum = ([r, g, b]) =>
    [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const problems = [];
  const rows = [...document.querySelectorAll('.wb-react-pills')];
  if (rows.length < 2) problems.push(`expected 2 pill rows, found ${rows.length}`);
  rows.forEach((row, r) => {
    if (row.children.length === 0) problems.push(`row ${r + 1} has no pills`);
    for (const el of [row, ...row.children]) {
      const box = el.getBoundingClientRect();
      if (box.left < thread.left - 0.5 || box.right > thread.right + 0.5) problems.push(`row ${r + 1} ${el === row ? 'row' : 'pill'} passes the thread (${Math.round(box.left)}-${Math.round(box.right)} in ${Math.round(thread.left)}-${Math.round(thread.right)})`);
    }
    for (const pill of row.children) {
      const style = getComputedStyle(pill);
      const contrast = ratio(rgb(style.color), backdrop(pill));
      if (contrast < 4.5) problems.push(`row ${r + 1} pill ${pill.textContent} text ${contrast.toFixed(2)}:1`);
    }
  });
  return { rows: rows.length, pills: rows.reduce((n, row) => n + row.children.length, 0), problems };
};

/** The open React popover and the thread it must stay inside; popover items must stay inside the popover. */
const popoverProblems = () => {
  const thread = document.querySelector('.wb-circle-thread').getBoundingClientRect();
  const pop = document.querySelector('.wb-react-wrap [data-slot="menu-content"]');
  if (!pop) return { problems: ['popover did not open'], items: 0 };
  const box = pop.getBoundingClientRect();
  const problems = [];
  if (box.left < thread.left - 0.5 || box.right > thread.right + 0.5) problems.push(`popover passes the thread (${Math.round(box.left)}-${Math.round(box.right)} in ${Math.round(thread.left)}-${Math.round(thread.right)})`);
  const items = [...pop.querySelectorAll('[role^="menuitem"]')];
  for (const item of items) {
    const r = item.getBoundingClientRect();
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5) problems.push('a pick passes the popover');
  }
  return { problems, items: items.length };
};

/** WCAG contrast of the own-message bubble's fill against the log, and of its text on the fill. */
const bubbleContrast = (bubble) => {
  const rgb = (value) => {
    const probe = document.createElement('div');
    probe.style.color = value;
    document.body.append(probe);
    const parts = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
    probe.remove();
    return parts.slice(0, 3);
  };
  const lum = ([r, g, b]) =>
    [r, g, b].map((c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  const style = getComputedStyle(bubble);
  let backdrop = bubble.closest('.wb-circle-log');
  while (backdrop.parentElement && /^rgba\(.*, 0\)$|transparent/.test(getComputedStyle(backdrop).backgroundColor)) backdrop = backdrop.parentElement;
  const page = rgb(getComputedStyle(backdrop).backgroundColor);
  const fill = rgb(style.backgroundColor);
  return { fill: ratio(fill, page), text: ratio(rgb(style.color), fill) };
};

const browser = await chromium.launch();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    // Reduced motion turns off the toolbar's fade, so a hover shows it at once.
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 720 }, reducedMotion: 'reduce' });
    await page.goto(`${url}?theme=${theme}`);
    await page.waitForSelector('.wb-circle-thread.is-compact');
    const states = { closed: await page.evaluate(overflow) };
    const lines = page.locator('.wb-circle-line');
    for (let i = 0; i < (await lines.count()); i++) {
      await lines.nth(i).hover();
      const problem = await lines.nth(i).evaluate(toolbarProblem);
      if (problem) {
        failed = true;
        console.log(`${theme} toolbar on message ${i + 1}: ${problem}`);
      }
    }
    states.hovered = await page.evaluate(overflow);

    const pills = await page.evaluate(pillProblems);
    for (const problem of pills.problems) {
      failed = true;
      console.log(`${theme} reactions: ${problem}`);
    }
    console.log(`${theme} reactions: ${pills.pills} pills in ${pills.rows} rows, ${pills.problems.length ? 'problems above' : 'inside the thread, text 4.5:1 or better'}`);

    // The popover opens from the first message's toolbar (the one with five emoji on it).
    await lines.nth(0).hover();
    await lines.nth(0).locator('button[aria-label="React"]').click();
    const pop = await page.evaluate(popoverProblems);
    if (pop.items !== 7) pop.problems.push(`expected 7 items with +, found ${pop.items}`);
    for (const problem of pop.problems) {
      failed = true;
      console.log(`${theme} react popover: ${problem}`);
    }
    states.popover = await page.evaluate(overflow);
    console.log(`${theme} react popover: ${pop.items} items, ${pop.problems.length ? 'problems above' : 'inside the thread'}`);
    await page.screenshot({ path: path.join(outDir, `compact-${theme}-popover.png`), fullPage: true });
    console.log(`${theme} popover screenshot: ${path.join(outDir, `compact-${theme}-popover.png`)}`);

    // The full picker, from "+": fits the window, and loads its data without leaving the site.
    const requests = [];
    const onRequest = (request) => requests.push(request.url());
    page.on('request', onRequest);
    await page.locator('.wb-react-wrap [data-slot="menu-content"] [role="menuitem"]:has-text("More emoji")').click();
    await page.waitForSelector('.wb-emoji-item', { state: 'attached' });
    const sheet = await page.$eval('.wb-emoji-sheet', (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: document.documentElement.clientWidth };
    });
    if (sheet.left < -0.5 || sheet.right > sheet.width + 0.5) {
      failed = true;
      console.log(`${theme} emoji picker passes the window (${Math.round(sheet.left)}-${Math.round(sheet.right)} in ${sheet.width})`);
    }
    const foreign = requests.filter((u) => !u.startsWith(url) && !u.startsWith('data:'));
    if (foreign.length) {
      failed = true;
      console.log(`${theme} emoji picker made ${foreign.length} request(s) off the site`);
    }
    page.off('request', onRequest);
    // The first theme must load the emoji data chunk; the second may find it cached.
    if (theme === 'dark' && !requests.some((u) => /\/assets\/data-[^/]+\.js$/.test(new URL(u).pathname))) {
      failed = true;
      console.log(`${theme} emoji picker: no request for the emoji data chunk was seen`);
    }
    console.log(`${theme} emoji picker: ${Math.round(sheet.left)}-${Math.round(sheet.right)} of ${sheet.width}px, ${requests.length} requests, ${foreign.length} off the site`);
    await page.screenshot({ path: path.join(outDir, `compact-${theme}-picker.png`) });
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    const bubble = await page.$eval('.wb-msg.is-user .wb-bubble:not(.is-gone)', bubbleContrast);
    const bubbleOk = bubble.fill >= 3 && bubble.text >= 4.5;
    if (!bubbleOk) failed = true;
    console.log(`${theme} own bubble: fill ${bubble.fill.toFixed(2)}:1 on the page, text ${bubble.text.toFixed(2)}:1${bubbleOk ? '' : ' (needs 3 and 4.5)'}`);
    await page.fill('textarea[aria-label^="Message"]', Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`).join('\n'));
    states.typed = await page.evaluate(overflow);
    const composerHeight = await page.$eval('textarea[aria-label^="Message"]', (box) => box.getBoundingClientRect().height);
    const shot = path.join(outDir, `compact-${theme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    for (const [state, result] of Object.entries(states)) {
      const ok = !result.scrolls && result.wide.length === 0;
      if (!ok) failed = true;
      console.log(`${theme} ${state}: ${ok ? 'no sideways scroll' : `scrolls=${result.scrolls} wide=${result.wide.join(', ')}`}`);
    }
    console.log(`${theme} composer height with 9 lines: ${Math.round(composerHeight)}px`);
    console.log(`${theme} screenshot: ${shot}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
process.exit(failed ? 1 : 0);
