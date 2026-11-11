/**
 * Screenshots and a short demo of the chat screen from made-up data (harness.tsx), for the
 * website and README. Writes, to the folder given as the first argument or a temp folder it
 * prints:
 *
 * - boundary-dark.png, boundary-light.png: the finished exchange, 1440x900 at 2x
 * - boundary-demo-dark.mp4, boundary-demo-light.mp4: the question typed and sent, and the reply
 *   streaming in, 1920x1200 at 30 fps
 * - boundary-demo-dark.gif, boundary-demo-light.gif: the same at 960 wide and 15 fps
 *
 * The demo needs ffmpeg on PATH; `--no-demo` skips it. Run with `bun run screenshot:ui [folder]`.
 * The Screenshot workflow runs it on each push to the public repository's main branch and
 * commits the files to its `screenshots` branch.
 *
 * The images are public, so only that workflow publishes them: by then promotion has removed
 * everything that isn't public. Run anywhere else, including any local checkout, the script
 * still renders, for working on the harness, but adds `-local` to every file name (for example
 * boundary-dark-local.png). Don't publish those.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const PUBLIC_REPOSITORY = 'BoundaryApp/boundary-desktop';
/** True only in a GitHub Actions run in the public repository. */
const publishing = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === PUBLIC_REPOSITORY;
const SUFFIX = publishing ? '' : '-local';

const args = process.argv.slice(2);
const withDemo = !args.includes('--no-demo');
const folder = args.find((arg) => !arg.startsWith('--'));
const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = folder ? path.resolve(folder) : mkdtempSync(path.join(tmpdir(), 'ui-screenshot-'));
mkdirSync(outDir, { recursive: true });
const siteDir = mkdtempSync(path.join(tmpdir(), 'ui-screenshot-site-'));
if (!publishing) {
  console.log(`Not the Screenshot workflow in ${PUBLIC_REPOSITORY}: file names end in ${SUFFIX} and are not for publishing.`);
}

/** A common laptop window. */
const VIEWPORT = { width: 1440, height: 900 };
/** Must match NOW in harness.tsx. */
const NOW = new Date('2026-11-09T10:30:00Z');
/** The last line of the made-up conversation: once it shows, the reply is all there. */
const LAST_LINE = 'Want me to post it in #volunteers?';
const THEMES = ['dark', 'light'];

const FPS = 30;
/** Characters typed per frame: 60 a second, quick enough that the typing doesn't drag. */
const CHARS_PER_FRAME = 2;
/** Pauses, in frames: before typing, after typing before the send, and on the finished reply. */
const HOLD_START = 20;
const HOLD_SENT = 10;
const HOLD_END = 90;
/** A demo still going after this many frames has lost its reply. */
const MAX_FRAMES = 30 * FPS;

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  plugins: [react(), tailwindcss()],
  define: { __BOUNDARY_APP_NAME__: '"Boundary"', __BOUNDARY_INSTANCE__: '""', global: 'globalThis' },
  // Unminified, so a page error names the function that threw.
  build: { outDir: siteDir, emptyOutDir: true, minify: false, chunkSizeWarningLimit: 100_000 },
});
const server = await preview({ root, configFile: false, logLevel: 'warn', build: { outDir: siteDir }, preview: { port: 0 } });
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch();
let failed = false;

async function openPage(theme, deviceScaleFactor) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor, colorScheme: theme, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' });
  page.on('pageerror', (error) => {
    console.log(`${theme}: page error: ${error.stack ?? error.message}`);
    failed = true;
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`${theme}: console error: ${message.text()}`);
  });
  return page;
}

/** Saves what did render, to see what's missing, and rethrows. */
async function keepFailed(page, name, error) {
  await page.screenshot({ path: path.join(outDir, `${name}${SUFFIX}-failed.png`) });
  throw error;
}

async function screenshot(theme) {
  const page = await openPage(theme, 2);
  await page.clock.setFixedTime(NOW);
  await page.goto(`${url}?theme=${theme}`);
  try {
    await page.getByText(LAST_LINE).waitFor({ timeout: 20_000 });
  } catch (error) {
    await keepFailed(page, `boundary-${theme}`, error);
  }
  await page.evaluate(() => document.fonts.ready);
  // Let the paced reveal and any entry transitions finish.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  const shot = path.join(outDir, `boundary-${theme}${SUFFIX}.png`);
  await page.screenshot({ path: shot });
  await page.close();
  console.log(`${theme}: ${shot}`);
}

/**
 * The page's timers run only when the script moves the clock, so each frame is the page
 * exactly 1/FPS s after the last, however long the machine takes to draw it.
 */
async function demo(theme) {
  // 1920 px wide frames, so the video needs no scaling.
  const page = await openPage(theme, 1920 / VIEWPORT.width);
  await page.clock.install({ time: NOW });
  // An installed clock still ticks in real time; paused, it moves only on runFor.
  await page.clock.pauseAt(new Date(NOW.getTime() + 1));
  await page.goto(`${url}?theme=${theme}&scene=demo`);
  // The placeholder carries the built-in agent's name, which harness.tsx takes from the app.
  const composer = page.getByPlaceholder(/^Ask .+ anything$/);
  // Loading waits on the page's timers too.
  for (let waited = 0; !(await composer.isVisible()); waited += 100) {
    if (waited > 20_000) await keepFailed(page, `boundary-demo-${theme}`, new Error('The composer never showed.'));
    await page.clock.runFor(100);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.clock.runFor(1000);
  await composer.click();

  const frames = mkdtempSync(path.join(tmpdir(), `ui-demo-${theme}-`));
  let frame = 0;
  let elapsed = 0;
  const capture = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      frame += 1;
      const at = Math.round((frame * 1000) / FPS);
      await page.clock.runFor(at - elapsed);
      elapsed = at;
      await page.screenshot({ path: path.join(frames, `frame-${String(frame).padStart(5, '0')}.png`) });
    }
  };

  await capture(HOLD_START);
  const question = await page.evaluate(() => window.uiShotQuestion);
  for (let i = 0; i < question.length; i += CHARS_PER_FRAME) {
    await page.keyboard.type(question.slice(i, i + CHARS_PER_FRAME));
    await capture();
  }
  await capture(HOLD_SENT);
  await page.keyboard.press('Enter');
  while (!(await page.getByText(LAST_LINE).isVisible())) {
    if (frame > MAX_FRAMES) await keepFailed(page, `boundary-demo-${theme}`, new Error('The reply never finished.'));
    await capture();
  }
  await capture(HOLD_END);
  await page.close();

  const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(frames, 'frame-%05d.png')];
  // bitexact keeps ffmpeg's version out of the file, so unchanged frames give an unchanged file.
  const bitexact = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1'];
  const mp4 = path.join(outDir, `boundary-demo-${theme}${SUFFIX}.mp4`);
  execFileSync('ffmpeg', [...input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', ...bitexact, mp4]);
  const gif = path.join(outDir, `boundary-demo-${theme}${SUFFIX}.gif`);
  const palette = 'fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  execFileSync('ffmpeg', [...input, '-vf', palette, ...bitexact, gif]);
  rmSync(frames, { recursive: true, force: true });
  console.log(`${theme}: ${mp4} (${frame} frames)`);
  console.log(`${theme}: ${gif}`);
}

try {
  for (const theme of THEMES) await screenshot(theme);
  if (withDemo) for (const theme of THEMES) await demo(theme);
} finally {
  await browser.close();
  server.httpServer.close();
  rmSync(siteDir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
