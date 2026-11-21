/**
 * Circles screen spec decision 22 and acceptance criteria 23 to 26: renders the Circles rail in
 * headless Chromium, in the dark and light themes, with 25 Circles, and fails if the open Circle's
 * header or first channel moves between Circles, if a dock row changes place when messages are
 * read or arrive, if the unread chip is missing, miscounts or does not scroll to the nearest
 * hidden row, if a short window shrinks the dock or the Circle area below its minimum, if a dock
 * row is not the height the resize steps assume, or if the page scrolls sideways. Run with
 * `bun run check:circle-rail`; screenshots land in a temp folder it prints.
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
const outDir = mkdtempSync(path.join(tmpdir(), 'circle-rail-'));
const TALL = 800;
const SHORT = 360;
const OPENED = [0, 3, 7, 12, 24];
const ROW_TOLERANCE = 4;

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

/** Waits for layout to settle after a change (two frames, for the rail's resize observers). */
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const rail = (page, fn, ...args) =>
  page.evaluate(([name, rest]) => window.__rail[name](...rest), [fn, args]).then(() => settle(page));

/** Tops of the open Circle's header and first channel. */
const areaTops = () => ({
  header: document.querySelector('.wb-circle-area-head').getBoundingClientRect().top,
  channel: document.querySelector('.wb-circle-area-sections .wb-row').getBoundingClientRect().top,
});

/** The dock's rows in order by name, and the distance from each row's top to the next row's. */
const dockRows = () => {
  const wraps = [...document.querySelectorAll('.wb-circles-row-wrap')];
  return wraps.map((wrap, i) => ({
    name: wrap.querySelector('.wb-row-title').textContent,
    pitch: i + 1 < wraps.length ? wraps[i + 1].getBoundingClientRect().top - wrap.getBoundingClientRect().top : null,
  }));
};

/**
 * What the chip should say, worked out from the rows' positions and not from the component: how
 * many unread rows lie past each edge of the dock's view, and the nearest one in each direction.
 */
const hiddenState = () => {
  const scroller = document.querySelector('.wb-circles-dock-rows');
  const rect = scroller.getBoundingClientRect();
  // The scroller's bottom padding is the room under the chip.
  const view = { top: rect.top, bottom: rect.bottom - parseFloat(getComputedStyle(scroller).paddingBottom) };
  const unread = [...document.querySelectorAll('.wb-circles-row-wrap[data-unread]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { name: el.querySelector('.wb-row-title').textContent, mid: (r.top + r.bottom) / 2 };
  });
  const below = unread.filter((row) => row.mid > view.bottom);
  const above = unread.filter((row) => row.mid < view.top);
  const chip = document.querySelector('.wb-circles-chip');
  return { below: below.length, above: above.length, nextBelow: below[0]?.name, nextAbove: above.at(-1)?.name, chip: chip ? chip.textContent : null };
};

/**
 * Whether the named dock row lies wholly inside the scroller's view and clear of the chip, given
 * the chip's rect from before the click (the chip may leave once the row is in view).
 */
const inView = ([name, chip]) => {
  const view = document.querySelector('.wb-circles-dock-rows').getBoundingClientRect();
  const wrap = [...document.querySelectorAll('.wb-circles-row-wrap')].find((el) => el.querySelector('.wb-row-title').textContent === name);
  const r = wrap.getBoundingClientRect();
  const inside = r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5;
  const clear = !chip || r.bottom <= chip.top + 0.5 || r.top >= chip.bottom - 0.5;
  return inside && clear;
};

const sizes = () => {
  const box = (selector) => document.querySelector(selector).getBoundingClientRect().height;
  const spacer = document.querySelector('.wb-titlebar-spacer').getBoundingClientRect().height;
  return { rail: box('.wb-circle-rail'), dock: box('.wb-circles-dock'), area: box('.wb-circle-area'), grip: box('.wb-circles-grip'), spacer };
};

const sideways = () => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.querySelector('.wb-circle-rail').scrollWidth > document.querySelector('.wb-circle-rail').clientWidth;

const browser = await chromium.launch();
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(message);
};
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: TALL }, reducedMotion: 'reduce' });
    await page.goto(`${url}?theme=${theme}`);
    await page.waitForSelector('.wb-circles-row-wrap');
    await page.waitForFunction(() => window.__rail);
    const limits = await page.evaluate(() => window.__rail.limits);

    // Criterion 23: the header and first channel stay put as the open Circle changes.
    const tops = [];
    for (const index of OPENED) {
      await rail(page, 'openCircle', index);
      tops.push(await page.evaluate(areaTops));
    }
    const moved = tops.some((t) => Math.abs(t.header - tops[0].header) > 0.5 || Math.abs(t.channel - tops[0].channel) > 0.5);
    if (moved) fail(`${theme} criterion 23: header/first channel tops differ across Circles: ${JSON.stringify(tops)}`);
    console.log(`${theme} area: header at ${tops[0].header}px, first channel at ${tops[0].channel}px in ${OPENED.length} Circles${moved ? ' (differ)' : ''}`);

    // A long name ends before the ⋯ button.
    const gap = await page.evaluate(() => document.querySelector('.wb-circles-row-more').getBoundingClientRect().left - document.querySelector('.wb-circle-area-name').getBoundingClientRect().right);
    if (gap < 0) fail(`${theme} header: the Circle name runs ${-gap}px under the ⋯ button`);
    else console.log(`${theme} header: the name ends ${gap}px before the ⋯ button`);

    // A scrolled Circle area does not carry its scroll position into the next Circle.
    await rail(page, 'openCircle', 0);
    const recorded = (await page.evaluate(areaTops)).channel;
    const scrolledTo = await page.evaluate(() => {
      const el = document.querySelector('.wb-circle-area-sections');
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    if (scrolledTo <= 0) fail(`${theme} Circle area scroll: the area could not be scrolled (scrollTop ${scrolledTo})`);
    for (const index of [2, 3]) {
      await rail(page, 'openCircle', index);
      const channel = (await page.evaluate(areaTops)).channel;
      const scrollTop = await page.evaluate(() => document.querySelector('.wb-circle-area-sections').scrollTop);
      if (Math.abs(channel - recorded) > 0.5 || scrollTop !== 0) {
        fail(`${theme} Circle area scroll: after scrolling Circle 1 by ${scrolledTo}px, Circle ${index + 1} has its first channel at ${channel}px (was ${recorded}px) and scrollTop ${scrollTop}`);
      }
    }
    console.log(`${theme} Circle area scroll: scrolled ${scrolledTo}px, then every next Circle opened with its first channel at ${recorded}px`);
    await rail(page, 'openCircle', 0);

    // Row height against ROW_PX.
    const rows = await page.evaluate(dockRows);
    const pitches = [...new Set(rows.flatMap((r) => (r.pitch === null ? [] : [Math.round(r.pitch * 10) / 10])))];
    const off = pitches.filter((p) => Math.abs(p - limits.rowPx) > ROW_TOLERANCE);
    if (off.length) fail(`${theme} dock row pitch ${pitches.join(', ')}px vs ROW_PX ${limits.rowPx}`);
    console.log(`${theme} dock row pitch: ${pitches.join(', ')}px (ROW_PX ${limits.rowPx})`);

    // Criterion 24: reading and arriving messages leave the order alone.
    await rail(page, 'openCircle', 0);
    const before = (await page.evaluate(dockRows)).map((r) => r.name);
    await rail(page, 'addUnread', 18);
    await rail(page, 'addUnread', 5);
    const afterAdd = (await page.evaluate(dockRows)).map((r) => r.name);
    await rail(page, 'addUnread', 0);
    await rail(page, 'markOpenRead');
    const afterRead = (await page.evaluate(dockRows)).map((r) => r.name);
    for (const [label, order] of [['a message arriving', afterAdd], ['marking the open Circle read', afterRead]]) {
      if (order.join('|') !== before.join('|')) fail(`${theme} criterion 24: dock order changed after ${label}`);
    }
    console.log(`${theme} dock order: ${before.length} rows, ${[afterAdd, afterRead].every((o) => o.join('|') === before.join('|')) ? 'same after an unread arrives and after reading' : 'changed (see above)'}`);

    // Criterion 25: the chip counts the hidden unread rows and takes you to the nearest.
    for (const index of [10, 14, 20]) await rail(page, 'addUnread', index);
    const scrollDock = (top) => page.evaluate((to) => { const el = document.querySelector('.wb-circles-dock-rows'); el.scrollTop = to === 'end' ? el.scrollHeight : to; }, top).then(() => settle(page));
    for (const [direction, scrollTo] of [['down', 0], ['up', 'end']]) {
      await scrollDock(scrollTo);
      const state = await page.evaluate(hiddenState);
      const count = direction === 'down' ? state.below : state.above;
      const nearest = direction === 'down' ? state.nextBelow : state.nextAbove;
      const arrow = direction === 'down' ? '↓' : '↑';
      if (!count || state.chip !== `${count} unread ${arrow}`) {
        fail(`${theme} criterion 25: ${count} unread rows ${direction === 'down' ? 'below' : 'above'}, chip reads ${JSON.stringify(state.chip)}`);
        continue;
      }
      const chipRect = await page.evaluate(() => {
        const r = document.querySelector('.wb-circles-chip').getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      });
      await page.locator('.wb-circles-chip').click();
      const arrived = await page.waitForFunction(inView, [nearest, chipRect], { timeout: 3000 }).then(() => true, () => false);
      if (!arrived) fail(`${theme} criterion 25: clicking "${state.chip}" left ${nearest} out of view or under the chip`);
      console.log(`${theme} chip: "${state.chip}" matches ${count} hidden unread rows; click ${arrived ? 'brought' : 'did not bring'} ${nearest} into view clear of the chip`);
    }
    await scrollDock(0);

    // The chip follows the dock's size: grow a minimum-height dock and the rows it newly shows
    // leave the count.
    await rail(page, 'setWanted', limits.dockMinPx);
    await scrollDock(0);
    const small = await page.evaluate(hiddenState);
    await page.locator('.wb-circles-grip').focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowUp');
    await settle(page);
    const grown = await page.evaluate(hiddenState);
    const shownBefore = small.chip ? Number.parseInt(small.chip, 10) : 0;
    const shownAfter = grown.chip ? Number.parseInt(grown.chip, 10) : 0;
    if (!small.chip || small.chip !== `${small.below} unread ↓`) fail(`${theme} chip on resize: small dock should hide ${small.below} unread rows below, chip reads ${JSON.stringify(small.chip)}`);
    if (shownAfter >= shownBefore) fail(`${theme} chip on resize: growing the dock left the chip at ${JSON.stringify(grown.chip)} (was ${JSON.stringify(small.chip)})`);
    if ((grown.below ? `${grown.below} unread ↓` : null) !== grown.chip && grown.below) fail(`${theme} chip on resize: ${grown.below} rows are hidden below but the chip reads ${JSON.stringify(grown.chip)}`);
    console.log(`${theme} chip on resize: "${small.chip}" in a minimum dock, ${grown.chip ? `"${grown.chip}"` : 'no chip'} after growing it`);

    await page.screenshot({ path: path.join(outDir, `rail-${theme}.png`) });
    console.log(`${theme} screenshot: ${path.join(outDir, `rail-${theme}.png`)}`);

    // Criterion 26: from 360px to 900px, with the dock wanted at its smallest and its largest, the
    // dock keeps its minimum and the Circle area keeps its own whenever the space they share allows.
    for (const wanted of [1, 10000]) {
      await rail(page, 'setWanted', wanted);
      const problems = [];
      let lastShort = null;
      for (let height = SHORT; height <= 900; height += 10) {
        await rail(page, 'setHeight', height);
        const size = await page.evaluate(sizes);
        const shared = size.rail - size.spacer;
        if (size.dock < limits.dockMinPx - 0.5) problems.push(`${height}px: dock ${size.dock}px under ${limits.dockMinPx}`);
        if (shared >= limits.dockMinPx + limits.areaMinPx && size.area < limits.areaMinPx - 0.5) {
          problems.push(`${height}px: Circle area ${size.area}px under ${limits.areaMinPx} with ${shared}px to share`);
        }
        if (height === SHORT) {
          lastShort = size;
          if (await page.evaluate(sideways)) problems.push(`${height}px: the page scrolls sideways`);
          await page.screenshot({ path: path.join(outDir, `rail-${theme}-short-${wanted}.png`) });
        }
      }
      for (const problem of problems) fail(`${theme} criterion 26 (dock wanted at ${wanted}px) at ${problem}`);
      console.log(`${theme} 360 to 900px sweep, dock wanted at ${wanted}px: ${problems.length ? 'problems above' : 'dock and Circle area keep their minimums'}; at 360px dock ${lastShort.dock}, area ${lastShort.area}`);
    }
    console.log(`${theme} short screenshots: ${[1, 10000].map((wanted) => path.join(outDir, `rail-${theme}-short-${wanted}.png`)).join(', ')}`);
    await rail(page, 'setHeight', null);

    if (await page.evaluate(sideways)) fail(`${theme}: the page scrolls sideways`);
    else console.log(`${theme}: no sideways scroll`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
process.exit(failed ? 1 : 0);
