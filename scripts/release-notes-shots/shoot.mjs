/**
 * Screenshots for release notes, with the boxes of the elements their callouts point at
 * (ADR 0059). The app draws the markers and rings from those boxes at view time, so they stay
 * sharp and follow the layout when it moves.
 *
 * It renders the app shell from the made-up data in scripts/ui-screenshot/harness.tsx, in
 * Chromium, with a fixed clock. Nothing reads real chats, a live stack or anyone's files.
 *
 *   bun run whats-new:shots <content dir> [version|guides/<id>]
 *
 * For every image a release's slides or a guide's steps name, it writes <image>.png beside that
 * release's release.json (or the guide's guide.json) and, when a callout names an anchor,
 * <image>.json with that anchor's box. An image with no scene, or an anchor that isn't on the
 * page, fails the run.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { anchorBoxesFor } from './markers.mjs';
import { SCENES, withExtraScenes } from './scenes.mjs';

/** Matches the harness's own window and clock, so a shot looks like the published ones. */
const VIEWPORT = { width: 1440, height: 900 };
const NOW = new Date('2026-11-09T10:30:00Z');

const args = process.argv.slice(2);
const dir = path.resolve(args[0] ?? process.env.BOUNDARY_RELEASE_NOTES_DIR ?? '');
const only = args[1];
if (!existsSync(dir)) {
  console.error(`No release notes folder at ${dir}. Pass one, or set BOUNDARY_RELEASE_NOTES_DIR.`);
  process.exit(2);
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every (owner, image, anchors) a slide or guide step asks for. */
function shotsWanted() {
  const wanted = [];
  // A slide can ship as text while its scene is written; there is nothing to shoot for it.
  const add = (owner, image, anchors) => {
    if (!image) return;
    const found = wanted.find((shot) => shot.owner === owner && shot.image === image);
    if (found) found.anchors = [...new Set([...found.anchors, ...anchors])];
    else wanted.push({ owner, image, anchors: [...anchors] });
  };

  for (const { version } of readJson(path.join(dir, 'releases.json'))) {
    const file = path.join(dir, version, 'release.json');
    if (!existsSync(file)) continue;
    for (const slide of readJson(file).slides ?? []) {
      add(version, slide.image, slide.anchor ? [slide.anchor] : []);
    }
  }

  const guidesDir = path.join(dir, 'guides');
  if (existsSync(guidesDir)) {
    for (const id of readdirSync(guidesDir)) {
      const file = path.join(guidesDir, id, 'guide.json');
      if (!existsSync(file)) continue;
      for (const step of readJson(file).steps ?? []) {
        add(`guides/${id}`, step.image, (step.callouts ?? []).map((callout) => callout.anchor));
      }
    }
  }

  return only ? wanted.filter((shot) => shot.owner === only) : wanted;
}

const wanted = shotsWanted();
if (wanted.length === 0) {
  console.log(only ? `Nothing to shoot for ${only}.` : 'Nothing to shoot.');
  process.exit(0);
}

/** A content folder may add scenes of its own in scenes.mjs beside its releases. */
const extraFile = path.join(dir, 'scenes.mjs');
const scenes = existsSync(extraFile)
  ? withExtraScenes((await import(pathToFileURL(extraFile).href)).SCENES ?? {})
  : SCENES;

const missing = wanted.filter((shot) => !scenes[shot.image]);
if (missing.length > 0) {
  for (const shot of missing) console.error(`No scene named "${shot.image}" (wanted by ${shot.owner})`);
  console.error(`Add it to scripts/release-notes-shots/scenes.mjs, or to ${extraFile}.`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui-screenshot');
const siteDir = mkdtempSync(path.join(tmpdir(), 'release-notes-shots-'));

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  // The harness bundles the content being shot, so a scene can show the notes themselves.
  resolve: { alias: { '@release-notes': dir } },
  plugins: [react(), tailwindcss()],
  define: { __BOUNDARY_APP_NAME__: '"Boundary"', __BOUNDARY_INSTANCE__: '""', global: 'globalThis' },
  build: { outDir: siteDir, emptyOutDir: true, minify: false, chunkSizeWarningLimit: 100_000 },
});
const server = await preview({ root, configFile: false, logLevel: 'warn', build: { outDir: siteDir }, preview: { port: 0 } });
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();

let failures = 0;
for (const shot of wanted) {
  const scene = scenes[shot.image];
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  });
  // A page error is printed but doesn't fail the run on its own: a render that really broke
  // leaves a blank screenshot, and reading the scene's anchors then fails below.
  page.on('pageerror', (error) => console.warn(`${shot.image}: page error: ${error.message}`));

  try {
    await page.clock.setFixedTime(NOW);
    await page.goto(`${url}?theme=dark&view=${scene.view}${scene.query ? `&${scene.query}` : ''}`);
    for (const step of scene.steps ?? []) {
      if (step.click) await page.locator(`[data-guide-anchor="${step.click}"]`).first().click();
      if (step.clickText) await page.getByText(step.clickText, { exact: true }).first().click();
      if (step.clickLabel) await page.getByLabel(step.clickLabel, { exact: true }).first().click();
      if (step.press) await page.keyboard.press(step.press);
      if (step.scrollText) await page.getByText(step.scrollText, { exact: true }).first().scrollIntoViewIfNeeded();
      if (step.hover) await page.locator(`[data-guide-anchor="${step.hover}"]`).first().hover();
      if (step.wait) await page.waitForTimeout(step.wait);
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);

    const folder = path.join(dir, shot.owner);
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, `${shot.image}.png`) });

    const named = shot.anchors.filter((anchor) => anchor);
    if (named.length > 0) {
      const unknown = named.filter((anchor) => !(scene.anchors ?? []).includes(anchor));
      if (unknown.length > 0) {
        throw new Error(`Scene "${shot.image}" doesn't list these anchors: ${unknown.join(', ')}`);
      }
      const boxes = await anchorBoxesFor(page, named);
      writeFileSync(path.join(folder, `${shot.image}.json`), `${JSON.stringify(boxes, null, 2)}\n`);
    }
    console.log(`${shot.owner}/${shot.image}.png`);
  } catch (error) {
    console.error(`${shot.owner}/${shot.image}: ${error.message}`);
    failures += 1;
  } finally {
    await page.close();
  }
}

await browser.close();
await server.close();
process.exit(failures > 0 ? 1 : 0);
