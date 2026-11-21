/**
 * Checks a release notes folder before it ships: slide and retention limits, guide ids that
 * resolve, screenshots and sidecars that exist, and callouts that name an anchor the sidecar
 * holds. `bun run check:release-notes` checks BOUNDARY_RELEASE_NOTES_DIR when it is set.
 *
 * The version compare is here rather than imported from src/main/services/updates/updateFeed.ts
 * because that is TypeScript and this runs under plain node.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_SLIDES = 6;
const MAX_RELEASES = 10;
/** The name of a release notes folder: at the repository root, or one level below it. */
const NOTES_FOLDER = 'whats-new';

/** Newer first: > 0 when `a` is newer than `b`. A prerelease sorts below its own release. */
export function compareReleaseVersions(a, b) {
  const parse = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version.trim());
    if (!match) return null;
    return {
      release: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ? match[4].split('.') : [],
    };
  };
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.release[i] !== y.release[i]) return x.release[i] - y.release[i];
  if (x.prerelease.length === 0 || y.prerelease.length === 0) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i += 1) {
    const [left, right] = [x.prerelease[i], y.prerelease[i]];
    if (left === undefined || right === undefined) return (left === undefined ? 0 : 1) - (right === undefined ? 0 : 1);
    if (left === right) continue;
    const [ln, rn] = [Number(left), Number(right)];
    if (Number.isInteger(ln) && Number.isInteger(rn)) return ln - rn;
    return left < right ? -1 : 1;
  }
  return 0;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Returns one message per problem; an empty array means the folder is fit to ship. */
export function checkReleaseNotes(dir) {
  const problems = [];
  const listed = readJson(join(dir, 'releases.json'));
  if (!Array.isArray(listed)) return [`${dir}/releases.json is missing or is not a list`];

  if (listed.length > MAX_RELEASES) problems.push(`releases.json lists ${listed.length} releases; keep at most 10 releases`);
  for (let i = 1; i < listed.length; i += 1) {
    const order = compareReleaseVersions(listed[i - 1].version, listed[i].version);
    if (order === null) problems.push(`releases.json has a version it cannot read: ${listed[i - 1].version} or ${listed[i].version}`);
    else if (order <= 0) problems.push(`releases.json must list releases newest first: ${listed[i - 1].version} before ${listed[i].version}`);
  }

  const versions = new Set(listed.map((release) => release.version));
  const guides = new Map();
  const guidesDir = join(dir, 'guides');
  if (existsSync(guidesDir)) {
    for (const id of readdirSync(guidesDir)) {
      if (!statSync(join(guidesDir, id)).isDirectory()) continue;
      const guide = readJson(join(guidesDir, id, 'guide.json'));
      if (!guide) problems.push(`guides/${id} has no readable guide.json`);
      else guides.set(id, guide);
    }
  }

  for (const entry of readdirSync(dir)) {
    if (entry === 'guides' || !statSync(join(dir, entry)).isDirectory()) continue;
    if (!versions.has(entry)) problems.push(`${entry} is not listed in releases.json`);
  }

  /** A screenshot and its sidecar, with every anchor the callers name. */
  const checkShot = (owner, image, anchors, where) => {
    if (!image) {
      // A slide can ship as text while its screenshot's scene is written; a ring cannot.
      if (anchors.length > 0) problems.push(`${where} rings an anchor but needs a screenshot`);
      return;
    }
    if (!existsSync(join(dir, owner, `${image}.png`))) {
      problems.push(`${where} has a missing image: ${owner}/${image}.png`);
      return;
    }
    if (anchors.length === 0) return;
    const boxes = readJson(join(dir, owner, `${image}.json`));
    if (!boxes) {
      problems.push(`${where} has a missing image sidecar: ${owner}/${image}.json`);
      return;
    }
    for (const anchor of anchors) {
      if (!(anchor in boxes)) problems.push(`${where} names an unknown anchor: ${anchor}`);
    }
  };

  for (const { version } of listed) {
    const detail = readJson(join(dir, version, 'release.json'));
    if (!detail) {
      problems.push(`${version} has no readable release.json`);
      continue;
    }
    const slides = detail.slides ?? [];
    if (slides.length === 0) problems.push(`${version} has no slides; a release with nothing to say needs no folder`);
    if (slides.length > MAX_SLIDES) problems.push(`${version} has ${slides.length} slides; keep at most 6 slides`);
    for (const slide of slides) {
      checkShot(version, slide.image, slide.anchor ? [slide.anchor] : [], `${version} slide "${slide.title}"`);
      if (slide.guide && !guides.has(slide.guide)) problems.push(`${version} slide "${slide.title}" links to an unknown guide: ${slide.guide}`);
    }
    for (const id of detail.guides ?? []) {
      if (!guides.has(id)) problems.push(`${version} lists an unknown guide: ${id}`);
    }
  }

  for (const [id, guide] of guides) {
    if ((guide.steps ?? []).length === 0) problems.push(`guide ${id} has no steps`);
    for (const step of guide.steps ?? []) {
      if (!step.title || !step.image) problems.push(`guide ${id} has a step with no title or image`);
      const anchors = (step.callouts ?? []).map((callout) => callout.anchor);
      checkShot(`guides/${id}`, step.image, anchors, `guide ${id} step "${step.title}"`);
    }
  }

  return problems;
}

/**
 * Every folder named whats-new that holds a releases.json, at `root` or in a folder directly
 * under it, so a build's notes and any other notes kept in the repository are all checked.
 * Skips dependencies and dot folders.
 */
export function findNotesFolders(root) {
  const candidates = [join(root, NOTES_FOLDER)];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    candidates.push(join(root, entry.name, NOTES_FOLDER));
  }
  return candidates.filter((dir) => existsSync(join(dir, 'releases.json')));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Without an argument: what this build would bundle, else the folder this repo ships, so the
  // content is checked on every `bun run check` and not only in the release workflow.
  const named = process.argv[2] ?? process.env.BOUNDARY_RELEASE_NOTES_DIR;
  const dirs = named ? [named] : findNotesFolders('.');
  if (dirs.length === 0) {
    console.log('No release notes folder to check.');
    process.exit(0);
  }
  let failed = false;
  for (const dir of dirs) {
    const problems = checkReleaseNotes(dir);
    for (const problem of problems) console.error(problem);
    console.log(problems.length ? `${problems.length} problem(s) in ${dir}.` : `Release notes in ${dir} are fit to ship.`);
    failed ||= problems.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
