/**
 * Renders the start-up screen of a launch after an upgrade in headless Chromium, with What's new
 * in the story slot, at several window sizes and in both themes. For each What's new slide
 * (the longest body and title a release has carried, one without a screenshot, a short one)
 * and for the tool story, fails when:
 *
 * - the story card passes the bottom of its slot, or overlaps the footer
 * - the "Why does this take a while?" or "Show details" pill is outside the window, or isn't
 *   the element a click at its centre lands on
 * - a What's new button (Read more, the slide dots) isn't the element a click lands on
 * - What's new text is cut off by anything but its own line clamp
 *
 * Run with `bun run check:startup-layout`; screenshots land in a temp folder it prints.
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
const outDir = mkdtempSync(path.join(tmpdir(), 'startup-layout-'));
/** The default window, a common laptop window, the windows either side of the heights where
 *  startup.css shrinks the ring (780px, and 860px while What's new shows), a narrow one and
 *  two short ones. */
const SIZES = [
  [1800, 1250],
  [1400, 900],
  [1280, 861],
  [900, 860],
  [900, 820],
  [1280, 781],
  [1200, 700],
  [900, 660],
];
/** Matches STORY_DELAY_MS in StartupScreen.tsx: a launch shows the story slot after this. */
const STORY_DELAY_MS = 6_000;

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@release-notes': path.join(root, 'notes') } },
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
  const label = (el) => (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40);
  const reachable = (el) => {
    const at = box(el);
    const x = at.left + at.width / 2;
    const y = at.top + at.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return `"${label(el)}" is outside the window`;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) {
      const by = hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing';
      return `a click on "${label(el)}" lands on ${by}`;
    }
    return null;
  };

  const slot = document.querySelector('.su-story-slot');
  const card = slot?.firstElementChild;
  const footer = document.querySelector('.su-footer');
  if (!card) return ['no story card'];
  const cardBox = box(card);
  const slack = box(slot).bottom - cardBox.bottom;
  if (slack < -0.5) problems.push(`the story card passes the bottom of its slot by ${(-slack).toFixed(1)}px`);
  const gap = box(footer).top - cardBox.bottom;
  if (gap < 0) problems.push(`the story card overlaps the footer by ${(-gap).toFixed(1)}px`);

  for (const pill of footer.querySelectorAll('.su-pill')) {
    const problem = reachable(pill);
    if (problem) problems.push(problem);
  }
  for (const button of card.querySelectorAll('button')) {
    const problem = reachable(button);
    if (problem) problems.push(problem);
  }
  // Text is cut off only where it is meant to be: by its own line clamp.
  for (const text of card.querySelectorAll('h2, p')) {
    const clamped = getComputedStyle(text).webkitLineClamp !== 'none';
    const at = box(text);
    for (let up = text.parentElement; up && up !== card.parentElement; up = up.parentElement) {
      const edges = box(up);
      if (at.bottom > edges.bottom + 0.5 || at.right > edges.right + 0.5) {
        problems.push(`"${label(text)}" passes the edge of ${up.tagName.toLowerCase()}.${[...up.classList].join('.')}`);
        break;
      }
    }
    if (!clamped && text.scrollHeight > text.clientHeight + 1) problems.push(`"${label(text)}" is cut off`);
  }
  return problems;
};

const browser = await chromium.launch();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of SIZES) {
      for (const notes of [true, false]) {
        const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
        page.on('pageerror', (error) => console.log(`  ${width}×${height} ${theme}: page error: ${error.message}`));
        await page.clock.install();
        await page.goto(`${url}?theme=${theme}${notes ? '' : '&notes=0'}`);
        await page.waitForSelector('.su-root');
        await page.clock.runFor(STORY_DELAY_MS + 1_000);
        await page.waitForSelector(notes ? '.su-whats-new' : '.su-story');
        const slides = notes
          ? await page.locator('.su-wn-dots button').evaluateAll((dots) => dots.map((dot) => dot.getAttribute('aria-label')))
          : [null];
        for (const [index, dot] of slides.entries()) {
          if (dot) await page.getByRole('button', { name: dot }).evaluate((button) => button.click());
          // Move the pointer off the card, so nothing is measured in its hover state.
          await page.mouse.move(0, 0);
          await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))));
          const state = `${width}x${height}-${notes ? `notes-${index + 1}` : 'tools'}-${theme}`;
          const problems = await page.evaluate(measure);
          await page.screenshot({ path: path.join(outDir, `${state}.png`) });
          console.log(`${state}: ${problems.length ? 'FAIL' : 'ok'}`);
          for (const line of problems) console.log(`  ${line}`);
          if (problems.length) failed = true;
        }
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.httpServer.close();
}
console.log(`Screenshots: ${outDir}`);
process.exitCode = failed ? 1 : 0;
