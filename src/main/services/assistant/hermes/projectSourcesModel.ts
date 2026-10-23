import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type {
  HermesIndexEntry,
  HermesSourceNextStep,
  HermesSourceRow,
  HermesSourceSpec,
  HermesSourceVisibility,
} from '../../../../shared/types/hermesChat';

export const SOURCES_NAME = 'sources.yaml';
export const INDEX_NAME = 'INDEX.md';
export const MANIFEST_NAME = '.index-manifest.json';
export const MANIFEST_VERSION = 2;
export const INDEX_CAP_PER_SOURCE = 200;
export const SOURCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
export const IMPLEMENTED_RETRIEVAL = 'files' as const;
export const RESERVED_RETRIEVAL = new Set(['lightrag', 'both']);
export const DEFAULT_INCLUDE = ['**/*.md', '**/*.txt'];
export const SKIP_NAMES = new Set([
  'AGENTS.md',
  'INDEX.md',
  'README.md',
  SOURCES_NAME,
  MANIFEST_NAME,
]);
export const SKIP_DIR_NAMES = new Set([
  'templates',
  'applications',
  'artifacts',
  'drafts',
]);

const FRONTMATTER_DESC = /^---\s*\n[\s\S]*?^description:\s*(.+?)\s*$[\s\S]*?\n---\s*\n/m;
const ATX_HEADING = /^#\s+(.+)$/m;

export class SourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesError';
  }
}

export interface MountRoots {
  contextRoots: string[];
  codingRoots: string[];
}

export interface CatalogFile {
  path: string;
  description: string;
  sourceId: string;
  size: number;
  mtimeNs: number;
  sha256: string;
}

export interface LoadedSources {
  sources: HermesSourceSpec[];
  explicit: boolean;
}

export function defaultSources(): HermesSourceSpec[] {
  return [
    {
      id: 'project',
      path: '.',
      retrieval: IMPLEMENTED_RETRIEVAL,
      include: [...DEFAULT_INCLUDE],
      exclude: [],
    },
  ];
}

export function splitColonPaths(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function isPathUnder(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  if (resolvedChild === resolvedParent) return true;
  const prefix = resolvedParent.endsWith(path.sep)
    ? resolvedParent
    : `${resolvedParent}${path.sep}`;
  return resolvedChild.startsWith(prefix);
}

function asStringList(value: unknown, field: string, sourceId: string): string[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' || !item.trim()) {
        throw new SourcesError(
          `source ${sourceId}: ${field} entries must be non-empty strings`
        );
      }
      out.push(item.trim());
    }
    return out;
  }
  throw new SourcesError(`source ${sourceId}: ${field} must be a list of strings`);
}

export function sourcesFromData(data: unknown): HermesSourceSpec[] {
  if (data == null || (typeof data === 'object' && Object.keys(data as object).length === 0)) {
    return defaultSources();
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new SourcesError('sources.yaml must be a mapping');
  }
  const root = data as Record<string, unknown>;
  const version = root.version ?? 1;
  if (version !== 1) {
    throw new SourcesError(`unsupported sources.yaml version: ${String(version)}`);
  }
  const rawSources = root.sources;
  if (rawSources == null) return defaultSources();
  if (!Array.isArray(rawSources)) {
    throw new SourcesError("sources.yaml 'sources' must be a list");
  }
  if (rawSources.length === 0) return defaultSources();

  const seen = new Set<string>();
  const out: HermesSourceSpec[] = [];
  rawSources.forEach((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SourcesError(`sources[${idx}] must be a mapping`);
    }
    const row = item as Record<string, unknown>;
    const sid = String(row.id ?? '').trim();
    if (!sid) throw new SourcesError(`sources[${idx}] is missing id`);
    if (!SOURCE_ID_RE.test(sid)) {
      throw new SourcesError(
        `invalid source id ${JSON.stringify(sid)} (use letters, numbers, hyphen, underscore)`
      );
    }
    if (seen.has(sid)) throw new SourcesError(`duplicate source id: ${sid}`);
    seen.add(sid);
    const rawPath = row.path;
    if (rawPath == null || !String(rawPath).trim()) {
      throw new SourcesError(`source ${sid}: path is required`);
    }
    const retrieval = String(row.retrieval ?? IMPLEMENTED_RETRIEVAL).trim();
    if (RESERVED_RETRIEVAL.has(retrieval)) {
      throw new SourcesError(
        `retrieval ${JSON.stringify(retrieval)} is not implemented yet (source id=${sid})`
      );
    }
    if (retrieval !== IMPLEMENTED_RETRIEVAL) {
      throw new SourcesError(
        `unknown retrieval ${JSON.stringify(retrieval)} (source id=${sid})`
      );
    }
    const include = asStringList(row.include, 'include', sid);
    const exclude = asStringList(row.exclude, 'exclude', sid);
    out.push({
      id: sid,
      path: String(rawPath).trim(),
      retrieval: IMPLEMENTED_RETRIEVAL,
      include: include.length > 0 ? include : [...DEFAULT_INCLUDE],
      exclude,
    });
  });
  return out;
}

export function parseSourcesYaml(text: string): HermesSourceSpec[] {
  let data: unknown;
  try {
    data = yaml.load(text) ?? {};
  } catch (err) {
    throw new SourcesError(
      `invalid sources.yaml: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return sourcesFromData(data);
}

export function extraHostPathsFromSources(sources: readonly HermesSourceSpec[]): string[] {
  const out: string[] = [];
  for (const spec of sources) {
    if (spec.path === '.' || !spec.path.startsWith('/')) continue;
    out.push(path.resolve(spec.path));
  }
  return out;
}

export function pathCoveredByRoots(hostPath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(hostPath);
  return roots.some((root) => isPathUnder(resolved, root));
}

export function sameResolvedPathSet(a: readonly string[], b: readonly string[]): boolean {
  const normalize = (list: readonly string[]) =>
    [...new Set(list.map((item) => path.resolve(item)))].sort((left, right) =>
      left.localeCompare(right)
    );
  const left = normalize(a);
  const right = normalize(b);
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function serializeColonPaths(paths: readonly string[]): string {
  return paths.join(':');
}

export function filterMountableContextRoots(
  candidates: readonly string[],
  options: {
    home: string;
    codingRoots: readonly string[];
    requireDirectory?: boolean;
  }
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (resolved === path.resolve('/') || samePath(resolved, options.home)) continue;
    if (pathCoveredByRoots(resolved, options.codingRoots)) continue;
    if (options.requireDirectory) {
      try {
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  out.sort((left, right) => left.localeCompare(right));
  return out;
}

export function serializeSourcesYaml(sources: HermesSourceSpec[]): string {
  const lines = [
    '# Hand-edited source registry. INDEX.md is generated — do not edit the tables.',
    '# Extra host directories are remounted by Boundary (read-only).',
    '# Use Add folder on the Sources rail. Do not prefix /opt/projects.',
    '# retrieval: files (implemented) | lightrag | both (reserved; indexer refuses)',
    'version: 1',
    'sources:',
  ];
  for (const spec of sources) {
    lines.push(`  - id: ${spec.id}`);
    lines.push(`    path: ${spec.path === '.' ? '.' : JSON.stringify(spec.path)}`);
    lines.push(`    retrieval: ${spec.retrieval}`);
    if (spec.include.length > 0) {
      lines.push(`    include: [${spec.include.map((p) => JSON.stringify(p)).join(', ')}]`);
    }
    if (spec.exclude.length > 0) {
      lines.push(`    exclude: [${spec.exclude.map((p) => JSON.stringify(p)).join(', ')}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function loadSources(projectRoot: string): LoadedSources {
  const file = path.join(projectRoot, SOURCES_NAME);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return { sources: defaultSources(), explicit: false };
  }
  const text = fs.readFileSync(file, 'utf8');
  return { sources: parseSourcesYaml(text), explicit: true };
}

export function resolveSourceRoot(projectRoot: string, spec: HermesSourceSpec): string {
  const raw = spec.path;
  if (raw === '~') {
    throw new SourcesError(`source ${spec.id}: path must not be $HOME alone`);
  }
  let root: string;
  if (raw.startsWith('~/')) {
    root = path.join(os.homedir(), raw.slice(2));
  } else if (raw === '.' || !raw.startsWith('/')) {
    root = path.resolve(projectRoot, raw);
  } else {
    root = path.resolve(raw);
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new SourcesError(`source ${spec.id}: path is not a directory: ${root}`);
  }
  return path.resolve(root);
}

export function globToRegExp(pattern: string): RegExp {
  let i = 0;
  let out = '^';
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 2;
      continue;
    }
    if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (pattern[i] === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('+.^$()[]{}|\\'.includes(pattern[i] ?? '')) {
      out += `\\${pattern[i]}`;
      i += 1;
      continue;
    }
    out += pattern[i];
    i += 1;
  }
  out += '$';
  return new RegExp(out);
}

export function globMatch(rel: string, pattern: string): boolean {
  const relN = rel.replace(/^\.\//, '');
  const pat = pattern.replace(/^\.\//, '');
  const matches = (value: string, glob: string) => globToRegExp(glob).test(value);
  if (matches(relN, pat)) return true;
  const parts = relN.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const suffix = parts.slice(i).join('/');
    if (matches(suffix, pat)) return true;
    if (pat.startsWith('**/') && matches(suffix, pat.slice(3))) return true;
  }
  return false;
}

export function shouldSkipRel(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  const name = parts[parts.length - 1];
  if (name && SKIP_NAMES.has(name)) return true;
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIR_NAMES.has(part) || part.startsWith('.')) return true;
  }
  return Boolean(name?.startsWith('.'));
}

export function stripFrontmatter(content: string): string {
  const text = content.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return text;
  const lines = text.split(/(?<=\n)/);
  if (!lines[0] || lines[0].trim() !== '---') return text;
  for (let idx = 1; idx < lines.length; idx += 1) {
    const trimmed = lines[idx]?.trim();
    if (trimmed === '---' || trimmed === '...') {
      return lines.slice(idx + 1).join('').replace(/^\n/, '');
    }
  }
  return text;
}

export function descriptionFor(filePath: string, content: string): string {
  const match = FRONTMATTER_DESC.exec(content.replace(/^\uFEFF/, ''));
  if (match?.[1]) {
    const desc = match[1].trim().replace(/^['"]|['"]$/g, '');
    if (desc) return desc;
  }
  const heading = ATX_HEADING.exec(stripFrontmatter(content));
  if (heading?.[1]) return heading[1].trim();
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[-_]/g, ' ');
}

export function indexPathFor(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  if (isPathUnder(resolved, root)) {
    return path.relative(root, resolved).split(path.sep).join('/');
  }
  return resolved;
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export async function iterSourceFiles(
  sourceRoot: string,
  spec: HermesSourceSpec
): Promise<string[]> {
  const files: string[] = [];
  for (const filePath of await walkFiles(sourceRoot)) {
    const rel = path.relative(sourceRoot, filePath).split(path.sep).join('/');
    if (shouldSkipRel(rel)) continue;
    if (spec.exclude.some((pat) => globMatch(rel, pat))) continue;
    if (!spec.include.some((pat) => globMatch(rel, pat))) continue;
    files.push(filePath);
  }
  return files;
}

export async function buildCatalog(
  projectRoot: string,
  sources: HermesSourceSpec[],
  cap = INDEX_CAP_PER_SOURCE
): Promise<{ files: CatalogFile[]; warnings: string[] }> {
  const files: CatalogFile[] = [];
  const warnings: string[] = [];
  for (const spec of sources) {
    let sourceRoot: string;
    try {
      sourceRoot = resolveSourceRoot(projectRoot, spec);
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    let found = await iterSourceFiles(sourceRoot, spec);
    if (cap && found.length > cap) {
      warnings.push(
        `source ${spec.id}: ${found.length} files, indexing first ${cap}`
      );
      found = found.slice(0, cap);
    }
    for (const filePath of found) {
      try {
        const data = await fs.promises.readFile(filePath);
        const st = await fs.promises.stat(filePath);
        files.push({
          path: indexPathFor(filePath, projectRoot),
          description: descriptionFor(filePath, data.toString('utf8')),
          sourceId: spec.id,
          size: st.size,
          mtimeNs: Math.round(st.mtimeMs * 1e6),
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        });
      } catch (err) {
        warnings.push(
          `source ${spec.id}: skipped ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }
  return { files, warnings };
}

export function renderIndex(files: CatalogFile[], grouped: boolean): string {
  const lines = [
    '# Index',
    '',
    'Generated by Refresh index. Do not hand-edit the tables; add a',
    "`description:` field in each source file's YAML frontmatter instead.",
    '',
  ];
  if (files.length === 0) {
    lines.push(
      '| Path | Description |',
      '| --- | --- |',
      '| _(no source markdown)_ | Add notes under this project, then Refresh index. |',
      ''
    );
    return lines.join('\n');
  }
  if (!grouped) {
    lines.push('| Path | Description |', '| --- | --- |');
    for (const item of files) {
      lines.push(`| \`${item.path}\` | ${item.description.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    return lines.join('\n');
  }
  const order: string[] = [];
  const bySource = new Map<string, CatalogFile[]>();
  for (const item of files) {
    if (!bySource.has(item.sourceId)) {
      bySource.set(item.sourceId, []);
      order.push(item.sourceId);
    }
    bySource.get(item.sourceId)?.push(item);
  }
  for (const sid of order) {
    const rows = bySource.get(sid) ?? [];
    lines.push(`## ${sid}`, '', '| Path | Description |', '| --- | --- |');
    for (const item of rows) {
      lines.push(`| \`${item.path}\` | ${item.description.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeSourcesYamlToHub(
  projectRoot: string,
  sources: HermesSourceSpec[]
): void {
  ensureDirectory(projectRoot);
  fs.writeFileSync(path.join(projectRoot, SOURCES_NAME), serializeSourcesYaml(sources), 'utf8');
}

/** Readers (inspect, the agent) never see a half-written file: write a sibling, then rename. */
async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

const indexWrites = new Map<string, Promise<string[]>>();

/**
 * Regenerate INDEX.md and its manifest. A second call for the same hub while one is running
 * gets that run's result instead of starting another, so two writes never interleave.
 */
export function writeIndex(
  projectRoot: string,
  sources: HermesSourceSpec[],
  grouped: boolean
): Promise<string[]> {
  const key = path.resolve(projectRoot);
  const running = indexWrites.get(key);
  if (running) return running;
  const run = writeIndexNow(projectRoot, sources, grouped).finally(() => {
    indexWrites.delete(key);
  });
  indexWrites.set(key, run);
  return run;
}

async function writeIndexNow(
  projectRoot: string,
  sources: HermesSourceSpec[],
  grouped: boolean
): Promise<string[]> {
  await fs.promises.mkdir(projectRoot, { recursive: true });
  const { files, warnings } = await buildCatalog(projectRoot, sources);
  const manifest = {
    version: MANIFEST_VERSION,
    files: files.map((item) => ({
      path: item.path,
      source_id: item.sourceId,
      size: item.size,
      mtime_ns: item.mtimeNs,
      sha256: item.sha256,
    })),
  };
  await writeFileAtomic(path.join(projectRoot, INDEX_NAME), renderIndex(files, grouped));
  await writeFileAtomic(
    path.join(projectRoot, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return warnings;
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Whether INDEX.md and its manifest still match the source files, without blocking the main
 * process. It lists the same files buildCatalog would and stats each one; a file whose size
 * and mtime match the manifest is taken as unchanged and never read. Only a file whose size
 * matches but whose mtime moved is hashed (streamed), so a touch without an edit stays fresh.
 */
export async function catalogIsFresh(
  projectRoot: string,
  sources: HermesSourceSpec[],
  cap = INDEX_CAP_PER_SOURCE
): Promise<boolean> {
  const manifestPath = path.join(projectRoot, MANIFEST_NAME);
  const indexPath = path.join(projectRoot, INDEX_NAME);
  let payload: unknown;
  try {
    await fs.promises.access(indexPath);
    payload = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  const recorded =
    payload && typeof payload === 'object'
      ? (payload as { files?: unknown }).files
      : undefined;
  if (!Array.isArray(recorded)) return false;
  const byPath = new Map<string, Record<string, unknown>>();
  for (const item of recorded) {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== 'string') return false;
    byPath.set(row.path, row);
  }

  let seen = 0;
  for (const spec of sources) {
    let sourceRoot: string;
    try {
      sourceRoot = resolveSourceRoot(projectRoot, spec);
    } catch {
      continue;
    }
    let found = await iterSourceFiles(sourceRoot, spec);
    if (cap && found.length > cap) found = found.slice(0, cap);
    for (const filePath of found) {
      const row = byPath.get(indexPathFor(filePath, projectRoot));
      if (!row) return false;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(filePath);
      } catch {
        // buildCatalog skips files it cannot read; the manifest lists this one, so it moved.
        return false;
      }
      seen += 1;
      if (row.size !== st.size) return false;
      if (row.mtime_ns === Math.round(st.mtimeMs * 1e6)) continue;
      try {
        if ((await hashFile(filePath)) !== row.sha256) return false;
      } catch {
        return false;
      }
    }
  }
  return seen === byPath.size && seen === recorded.length;
}

export function parseIndexMarkdown(text: string): HermesIndexEntry[] {
  const entries: HermesIndexEntry[] = [];
  let sourceId = 'project';
  for (const raw of text.split(/\r?\n/)) {
    const heading = raw.match(/^##\s+(.+?)\s*$/);
    if (heading?.[1]) {
      sourceId = heading[1].trim();
      continue;
    }
    const row = raw.match(/^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!row?.[1]) continue;
    const filePath = row[1];
    const description = (row[2] ?? '').replace(/\\\|/g, '|');
    const absolute = filePath.startsWith('/');
    entries.push({
      sourceId,
      path: filePath,
      description,
      kind: absolute ? 'absolute' : 'relative',
      visible: true,
    });
  }
  return entries;
}

export function visibilityForSource(
  spec: HermesSourceSpec,
  hostPath: string,
  hubPath: string,
  mounts: MountRoots
): HermesSourceVisibility {
  if (spec.path === '.' || samePath(hostPath, hubPath)) return 'hub';
  if (mounts.contextRoots.some((root) => isPathUnder(hostPath, root))) {
    return 'readonly';
  }
  if (mounts.codingRoots.some((root) => isPathUnder(hostPath, root))) {
    return 'writable';
  }
  return 'unmounted';
}

export type AddFolderRefuseReason =
  | 'home'
  | 'root'
  | 'hub'
  | 'library-project'
  | 'under-hub';

export function refuseAddFolderReason(
  hostPath: string,
  options: {
    home: string;
    hubPath: string;
    otherProjectHostPaths: string[];
    libraryProjectsRoot?: string;
  }
): AddFolderRefuseReason | null {
  const resolved = path.resolve(hostPath);
  if (resolved === path.resolve('/') || hostPath === '/') return 'root';
  if (samePath(resolved, options.home)) return 'home';
  if (samePath(resolved, options.hubPath) || isPathUnder(resolved, options.hubPath)) {
    return samePath(resolved, options.hubPath) ? 'hub' : 'under-hub';
  }
  for (const other of options.otherProjectHostPaths) {
    if (samePath(resolved, other) || isPathUnder(resolved, other)) {
      return 'library-project';
    }
  }
  if (options.libraryProjectsRoot) {
    const lib = path.resolve(options.libraryProjectsRoot);
    if (path.dirname(resolved) === lib) return 'library-project';
  }
  return null;
}

export function refuseMessage(reason: AddFolderRefuseReason): string {
  switch (reason) {
    case 'home':
      return 'Never mount the home folder.';
    case 'root':
      return 'Never mount the filesystem root.';
    case 'hub':
      return 'This is the hub. Extra sources must be a different folder.';
    case 'under-hub':
      return 'That folder is already inside the hub.';
    case 'library-project':
      return 'That folder is another library project. Open it instead.';
  }
}

export function slugifySourceId(name: string, existing: string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'source';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function rowsForSources(
  sources: HermesSourceSpec[],
  projectRoot: string,
  mounts: MountRoots
): HermesSourceRow[] {
  return sources.map((spec) => {
    let hostPath = projectRoot;
    try {
      hostPath = resolveSourceRoot(projectRoot, spec);
    } catch {
      if (spec.path !== '.' && spec.path.startsWith('/')) {
        hostPath = path.resolve(spec.path);
      } else if (spec.path.startsWith('~/')) {
        hostPath = path.join(os.homedir(), spec.path.slice(2));
      }
    }
    return {
      id: spec.id,
      path: spec.path,
      hostPath,
      retrieval: spec.retrieval,
      visibility: visibilityForSource(spec, hostPath, projectRoot, mounts),
      isHub: spec.path === '.' || samePath(hostPath, projectRoot),
    };
  });
}

export function annotateIndexVisibility(
  entries: HermesIndexEntry[],
  rows: HermesSourceRow[]
): HermesIndexEntry[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return entries.map((entry) => {
    const row = byId.get(entry.sourceId);
    if (!row || row.isHub) return { ...entry, visible: true };
    return { ...entry, visible: row.visibility !== 'unmounted' };
  });
}

export function buildNextStep(
  rows: HermesSourceRow[],
  stale: boolean,
  _slug?: string
): HermesSourceNextStep | undefined {
  const extras = rows.filter((row) => !row.isHub);
  if (extras.length === 0) return undefined;
  const unmounted = extras.find((row) => row.visibility === 'unmounted');
  if (unmounted) {
    return {
      tone: 'deny',
      title: `${unmounted.id} isn’t visible yet.`,
      body: 'Remount from this screen, then Refresh index.',
    };
  }
  const writable = extras.find((row) => row.visibility === 'writable');
  if (writable) {
    return {
      tone: 'warn',
      title: 'This extra folder is writable.',
      body: 'It sits under a coding root. Prefer a dedicated read-only notes folder.',
    };
  }
  if (stale) {
    return {
      tone: 'ok',
      title: 'Index is behind the files.',
      body: 'Refresh rewrites INDEX.md from this Mac.',
    };
  }
  return undefined;
}

export function opensPreview(
  entry: HermesIndexEntry,
  containerPath: string
): { title: string; detail: string } {
  if (entry.kind === 'relative') {
    return {
      title: 'Opens as written',
      detail: `${entry.path} → ${containerPath.replace(/\/$/, '')}/${entry.path}`,
    };
  }
  if (!entry.visible) {
    return {
      title: 'Opens as written',
      detail: `${entry.path}\nDo not prefix /opt/projects.`,
    };
  }
  return {
    title: 'Opens as written',
    detail: `${entry.path}\nDo not prefix /opt/projects.`,
  };
}
