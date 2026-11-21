/**
 * Import graph between source areas, for scripts/check-imports.mjs. Pure functions: the caller
 * passes file contents and an existence test, so tests can run them on a made-up tree.
 *
 * An area is one experiment, one main-process service, one product UI folder, or one of the
 * shared layers (see `areaOf`). Test files are left out by the caller.
 */
import { dirname, join, normalize } from 'node:path';

/**
 * The area a `src/` path belongs to, or null outside `src/`.
 * @param {string} path repo-relative, forward slashes
 */
export function areaOf(path) {
  const parts = path.split('/');
  if (parts[0] !== 'src') return null;
  const [, top, second, third] = parts;
  if (top === 'experiments') return parts.length > 3 ? `exp:${second}` : 'exp:root';
  if (top === 'main') {
    if (second === 'services') return parts.length > 4 ? `main:${third}` : 'main:services-root';
    return 'main:core';
  }
  if (top === 'renderer') {
    if (second === 'product') return parts.length > 4 ? `ui:${third}` : 'ui:shell';
    if (second === 'components') return 'ui:components';
    return 'renderer:core';
  }
  if (top === 'shared') return 'shared';
  return top.startsWith('preload') ? 'preload' : 'renderer:core';
}

/**
 * Edges every area may use without an allowance: anything into `shared`, and renderer or
 * experiment code into the design system components.
 * @param {string} key `"a -> b"`
 */
export function alwaysAllowed(key) {
  const [from, to] = key.split(' -> ');
  if (to === 'shared') return true;
  const side = sideOf(from);
  return to === 'ui:components' && (side === 'renderer' || side === 'experiment');
}

/** Which process an area's code runs in. Shared code may run in any of them. */
function sideOf(area) {
  if (area === 'shared') return 'shared';
  if (area.startsWith('exp:')) return 'experiment';
  if (area.startsWith('main:')) return 'main';
  if (area.startsWith('ui:') || area.startsWith('renderer:')) return 'renderer';
  return 'preload';
}

const IMPORT =
  /(?:^|[;\s}])(?:import|export)\s(?:type\s)?[^;'"]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[;\s])import\s*['"]([^'"]+)['"]/g;

/**
 * Module specifiers in a source file: static imports and re-exports, side-effect imports and
 * dynamic `import()` with a string literal. Comments are not stripped.
 * @param {string} source
 */
export function importSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(IMPORT)) found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

const SUFFIXES = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

/**
 * The repo-relative file a relative specifier points at, or null for a package import.
 * Returns `{ unresolved }` when no file matches.
 * @param {string} from importing file
 * @param {string} specifier
 * @param {(path: string) => boolean} isFile
 */
function resolveImport(from, specifier, isFile) {
  if (!specifier.startsWith('.')) return null;
  const base = normalize(join(dirname(from), specifier)).split('\\').join('/');
  for (const suffix of SUFFIXES) {
    if (isFile(base + suffix)) return { file: base + suffix };
  }
  return { unresolved: base };
}

/**
 * Host files: the entries through which the core app offers itself to features. Importing one
 * adds no edge between areas, and neither do a host file's own imports within its process.
 * @param {string} path repo-relative, forward slashes
 */
export function isHostFile(path) {
  return (
    path.startsWith('src/main/host/') ||
    path.startsWith('src/renderer/host/') ||
    path === 'src/preloadExperiments.ts' ||
    path === 'src/preloadHost.ts'
  );
}

/**
 * Every import from one area into another. Imports of host files and a host file's own imports
 * are left out of `edges` unless they cross a process line (see `isHostFile`).
 * @param {string[]} files
 * @param {(path: string) => string} read
 * @param {(path: string) => boolean} isFile
 * @returns {{ edges: Map<string, { from: string; to: string }[]>; imports: Map<string, string[]>; unresolved: { from: string; specifier: string }[] }}
 *   `edges` is keyed `"a -> b"`; `imports` maps each file to the files it imports.
 */
export function importGraph(files, read, isFile) {
  const edges = new Map();
  const imports = new Map();
  const unresolved = [];
  for (const from of files) {
    const fromArea = areaOf(from);
    const targets = [];
    for (const specifier of importSpecifiers(read(from))) {
      const resolved = resolveImport(from, specifier, isFile);
      if (resolved === null) continue;
      if ('unresolved' in resolved) {
        unresolved.push({ from, specifier });
        continue;
      }
      targets.push(resolved.file);
      const toArea = areaOf(resolved.file);
      if (toArea === null || toArea === fromArea) continue;
      const key = `${fromArea} -> ${toArea}`;
      if (isHostFile(resolved.file) && forbiddenReason(key) === null) continue;
      if (isHostFile(from) && forbiddenReason(key) === null) continue;
      if (!edges.has(key)) edges.set(key, []);
      edges.get(key).push({ from, to: resolved.file });
    }
    imports.set(from, targets);
  }
  return { edges, imports, unresolved };
}

/**
 * Imports that break a rule no allowance can lift: renderer and main code importing each
 * other, preload importing either, and any import into an experiment from outside it.
 * @param {string} key `"a -> b"`
 * @returns {string | null} the reason, or null when the edge may be allowed
 */
export function forbiddenReason(key) {
  const [from, to] = key.split(' -> ');
  const fromSide = sideOf(from);
  const toSide = sideOf(to);
  if (toSide === 'experiment' && fromSide !== 'experiment') {
    return 'only experiments may import experiment code';
  }
  if (fromSide === 'shared' && toSide !== 'shared') return 'shared code may only import shared code';
  const pair = `${fromSide}/${toSide}`;
  if (pair === 'main/renderer' || pair === 'renderer/main') {
    return 'main and renderer code talk over IPC through shared types, not imports';
  }
  if (fromSide === 'preload' && (toSide === 'main' || toSide === 'renderer')) {
    return 'preload code may only import shared code';
  }
  return null;
}

/**
 * Files reachable from `entry` that live outside `entry`'s area and `shared`. A process entry
 * bundled on its own keeps its whole import tree inside its area.
 * @param {string} entry
 * @param {Map<string, string[]>} imports
 * @returns {{ from: string; to: string }[]}
 */
export function leavesArea(entry, imports) {
  const area = areaOf(entry);
  const seen = new Set([entry]);
  const queue = [entry];
  const outside = [];
  while (queue.length > 0) {
    const file = queue.shift();
    for (const target of imports.get(file) ?? []) {
      const targetArea = areaOf(target);
      if (targetArea !== area && targetArea !== 'shared') {
        outside.push({ from: file, to: target });
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return outside;
}

/**
 * Imports from a host client into a core area. Host files add no edges, so every such import
 * bypasses the host API.
 * @param {Map<string, { from: string; to: string }[]>} edges
 * @param {(area: string) => boolean} isClient
 * @param {Set<string>} coreAreas
 * @returns {{ from: string; to: string }[]}
 */
export function hostViolations(edges, isClient, coreAreas) {
  const found = [];
  for (const [key, list] of edges) {
    const [from, to] = key.split(' -> ');
    if (isClient(from) && coreAreas.has(to)) found.push(...list);
  }
  return found;
}

/**
 * Imports into an area with declared entries whose target is not one of them.
 * @param {Map<string, { from: string; to: string }[]>} edges
 * @param {Record<string, string[]>} entries area to its entry files
 * @returns {{ from: string; to: string }[]}
 */
export function entryViolations(edges, entries) {
  const found = [];
  for (const [key, list] of edges) {
    const allowed = entries[key.split(' -> ')[1]];
    if (allowed === undefined) continue;
    found.push(...list.filter(({ to }) => !allowed.includes(to)));
  }
  return found;
}
