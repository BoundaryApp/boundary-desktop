/**
 * Circle chats spec phase 7: renders the compact Circle thread at 320px in headless Chromium,
 * in the dark and light themes, and fails if anything scrolls sideways. Run with
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

const browser = await chromium.launch();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 720 } });
    await page.goto(`${url}?theme=${theme}`);
    await page.waitForSelector('.wb-circle-thread.is-compact');
    const states = { closed: await page.evaluate(overflow) };
    await page.locator('button[aria-label="Message actions"]').first().click();
    states.actions = await page.evaluate(overflow);
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
