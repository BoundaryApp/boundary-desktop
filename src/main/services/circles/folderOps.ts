/**
 * What a shared folder's Autobase holds and how its operations apply (ADR 0049 §2–§7). Like
 * `circleOps.ts`, this runs inside Autobase's `apply` on every peer, in the order the indexers
 * settle on, so it must be deterministic: no clock, no randomness, nothing outside the view. An
 * operation its author may not perform is skipped, never thrown on.
 *
 * A folder has its own format from its first build, and ADR 0038's rules apply to it: what an
 * operation does at a format never changes.
 *
 * Kept free of native modules so it can be tested on its own; the signature check is passed in.
 */

import { type ApplyHost, type ApplyNode, type ApplyView, applyEach } from './autobaseApply';

/** The highest folder format this build can apply. New folders start at it. */
export const FOLDER_FORMAT = 1;

/** Managers index and change roles; editors write; readers only replicate (ADR 0049 §5). */
export type FolderRole = 'manager' | 'editor' | 'reader';

/** How a device joins a folder as a writer. Hex strings throughout. */
export interface FolderDeviceIntro {
  /** The person's identity key, the same as in their Circles (ADR 0032 §2). */
  identity: string;
  name: string;
  device: string;
  /** The device's writer core for this folder. */
  writer: string;
  /** The device's blob core for this folder, which holds the contents it writes (ADR 0049 §4). */
  blobs: string;
  /** The identity's signature over `device ‖ writer ‖ blobs`. */
  signature: string;
}

/** Where a file's contents sit in a blob core (hyperblobs' id). */
export interface FolderBlobRef {
  core: string;
  blockOffset: number;
  blockLength: number;
  byteOffset: number;
  byteLength: number;
}

export type FolderOp =
  | { type: 'create'; name: string; format: number; role: Exclude<FolderRole, 'manager'>; member: FolderDeviceIntro }
  | { type: 'set-format'; format: number }
  | { type: 'add-writer'; member: FolderDeviceIntro }
  | { type: 'set-role'; identity: string; name?: string; role: FolderRole }
  | { type: 'remove-person'; identity: string }
  | { type: 'put'; path: string; base: number | null; blob: FolderBlobRef; size: number; hash: string; at: number }
  | { type: 'del'; path: string; base: number; at: number };

/** The view's `FOLDER_KEY` entry. */
export interface FolderHeader {
  name: string;
  /** Only rises (ADR 0038). */
  format: number;
  /** The role people get when a manager first adds them (ADR 0049 §5). */
  role: Exclude<FolderRole, 'manager'>;
  /** Who shared it. */
  by: string;
}

export interface FolderPerson {
  identity: string;
  name: string;
  role: FolderRole;
}

export interface FolderWriter {
  identity: string;
  device: string;
  blobs: string;
  /** The writer core, also the record's key. */
  writer: string;
}

/** A file as the view holds it, keyed by its folded path. A deleted file keeps a tombstone. */
export interface FolderFile {
  /** The path as its author wrote it, after NFC normalization. */
  path: string;
  /** Starts at 1 and rises by one with every applied change, delete included. */
  version: number;
  deleted: boolean;
  /** Absent on a tombstone. */
  blob?: FolderBlobRef;
  size?: number;
  hash?: string;
  /** Who wrote this version. */
  identity: string;
  writer: string;
  /** The author's clock in milliseconds; shown, never used for order. */
  at: number;
  /** Set on a copy made because this change crossed another one (ADR 0049 §7). */
  conflictOf?: string;
}

/** View keys. */
export const FOLDER_KEY = 'folder';
export const PEOPLE_PREFIX = 'people/';
export const WRITERS_PREFIX = 'writers/';
export const FILES_PREFIX = 'files/';
export const personKey = (identity: string): string => `${PEOPLE_PREFIX}${identity}`;
const writerKey = (writer: string): string => `${WRITERS_PREFIX}${writer}`;
export const fileKey = (path: string): string => `${FILES_PREFIX}${foldPath(path)}`;

export type FolderView = ApplyView;
export type FolderHost = ApplyHost;
export type FolderNode = ApplyNode;

export interface FolderApplyDeps {
  /** ed25519 verify over raw bytes. */
  verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
  /** The highest format to apply; `FOLDER_FORMAT` unless a test stands in for another build. */
  supportedFormat?: number;
  /** Called with each skipped operation and why, for the debug log. Never log the operation's paths. */
  onSkip?(reason: string): void;
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const MAX_NAME = 80;
/** The longest path, as UTF-8 (ADR 0049 §6). */
const MAX_PATH_BYTES = 1024;
/** The largest file a folder shares (ADR 0049 §9). */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Characters a path can't hold: controls (NUL included) and the backslash. */
// eslint-disable-next-line no-control-regex
const BAD_PATH_CHARS = /[\u0000-\u001f\u007f\\]/;
/** Folders whose contents are never shared, wherever they sit (ADR 0049 §9). */
const NEVER_SHARED_DIRS = new Set(['.git', 'node_modules']);
/** Templates that `.env.*` doesn't cover (ADR 0028 §6). */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template']);

/** The bytes an identity signs to vouch for a device's writer and blob core in one folder. */
export function folderDeviceProof(device: string, writer: string, blobs: string): Buffer {
  return Buffer.concat([Buffer.from(device, 'hex'), Buffer.from(writer, 'hex'), Buffer.from(blobs, 'hex')]);
}

/** A well-formed intro whose identity really signed this device, writer and blob core. */
function folderIntroIsValid(value: unknown, deps: Pick<FolderApplyDeps, 'verify'>): value is FolderDeviceIntro {
  const intro = value as FolderDeviceIntro;
  if (typeof intro !== 'object' || intro === null) return false;
  if (![intro.identity, intro.device, intro.writer, intro.blobs].every((key) => typeof key === 'string' && HEX_KEY.test(key))) {
    return false;
  }
  if (typeof intro.signature !== 'string' || !HEX_SIGNATURE.test(intro.signature) || !isName(intro.name)) return false;
  try {
    return deps.verify(
      folderDeviceProof(intro.device, intro.writer, intro.blobs),
      Buffer.from(intro.signature, 'hex'),
      Buffer.from(intro.identity, 'hex')
    );
  } catch {
    return false;
  }
}

const isName = (name: unknown): name is string => typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_NAME;
const isFormat = (format: unknown): format is number => Number.isInteger(format) && (format as number) >= 1;
const isRole = (role: unknown): role is FolderRole => role === 'manager' || role === 'editor' || role === 'reader';
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/**
 * The path as the view stores it, or null when it can't be shared: relative, `/`-separated, no
 * empty, `.` or `..` segments, no control characters or backslashes, at most `MAX_PATH_BYTES`.
 */
export function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.normalize('NFC');
  if (!path || Buffer.byteLength(path) > MAX_PATH_BYTES || BAD_PATH_CHARS.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return path;
}

/** Whether a path is one ADR 0049 §9 keeps on the Mac it was written on. */
export function isNeverShared(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => NEVER_SHARED_DIRS.has(segment))) return true;
  const name = segments[segments.length - 1];
  if (NEVER_SHARED_DIRS.has(name) || name === '.DS_Store') return true;
  return (name === '.env' || name.startsWith('.env.')) && !ENV_TEMPLATES.has(name);
}

/**
 * The key a path is compared by. macOS's default filesystem treats `Notes.md` and `notes.md` as one
 * file, so paths are compared after NFC and lower-casing (ADR 0049 §6). Lower-casing follows the
 * runtime's Unicode tables, which are stable for characters assigned before both builds' Unicode
 * versions; a character assigned later could fold differently between builds.
 */
function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

/** The path of the copy kept when a change crosses another (ADR 0049 §7). */
export function conflictPath(path: string, name: string, attempt: number): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  // A leading dot starts a hidden file's name, not an extension.
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  const who = name.replace(/[/\\]/g, ' ').trim();
  return `${dir}${stem} (conflict, ${who}${attempt > 1 ? ` ${attempt}` : ''})${ext}`;
}

function cleanBlob(value: unknown, size: number): FolderBlobRef | null {
  const blob = value as FolderBlobRef;
  if (typeof blob !== 'object' || blob === null || typeof blob.core !== 'string' || !HEX_KEY.test(blob.core)) return null;
  const { blockOffset, blockLength, byteOffset, byteLength } = blob;
  if (![blockOffset, blockLength, byteOffset, byteLength].every(isCount)) return null;
  if (byteLength !== size || (size > 0 && blockLength === 0)) return null;
  return { core: blob.core, blockOffset, blockLength, byteOffset, byteLength };
}

async function read<T>(view: FolderView, key: string): Promise<T | null> {
  const node = await view.get(key);
  return node ? (node.value as T) : null;
}

async function managers(view: FolderView): Promise<FolderPerson[]> {
  return ((await view.list(PEOPLE_PREFIX)) as FolderPerson[]).filter((person) => person.role === 'manager');
}

/** The writer cores of one person's devices. */
async function writersOf(view: FolderView, identity: string): Promise<string[]> {
  const writers = (await view.list(WRITERS_PREFIX)) as FolderWriter[];
  return writers.filter((writer) => writer.identity === identity).map((writer) => writer.writer);
}

/** Apply a batch of folder operations to the view (Autobase's `apply`). */
export async function applyFolderNodes(
  nodes: FolderNode[],
  view: FolderView,
  host: FolderHost,
  deps: FolderApplyDeps
): Promise<void> {
  await applyEach(nodes, (node) => applyOne(node, view, host, deps), (reason) => deps.onSkip?.(reason));
}

async function applyOne(node: FolderNode, view: FolderView, host: FolderHost, deps: FolderApplyDeps): Promise<string | null> {
  const op = node.value as FolderOp;
  if (typeof op !== 'object' || op === null) return 'not an operation';
  const from = node.from.key.toString('hex');
  const folder = await read<FolderHeader>(view, FOLDER_KEY);
  const supported = deps.supportedFormat ?? FOLDER_FORMAT;

  if (op.type === 'create') {
    if (folder) return 'the folder already exists';
    if (!isName(op.name)) return 'bad name';
    if (!isFormat(op.format)) return 'bad format';
    if (op.role !== 'editor' && op.role !== 'reader') return 'bad role';
    // The creator's device is the bootstrap writer and already an indexer.
    if (!folderIntroIsValid(op.member, deps) || op.member.writer !== from) return 'bad creator intro';
    if (op.format > supported) host.interrupt(`folder format ${op.format}`);
    const { identity, name, device, blobs } = op.member;
    await view.put(FOLDER_KEY, { name: op.name.trim(), format: op.format, role: op.role, by: identity });
    await view.put(personKey(identity), { identity, name: name.trim(), role: 'manager' });
    await view.put(writerKey(from), { identity, device, blobs, writer: from });
    return null;
  }
  if (!folder) return 'the folder has not been created';

  const writer = await read<FolderWriter>(view, writerKey(from));
  const author = writer ? await read<FolderPerson>(view, personKey(writer.identity)) : null;
  if (!writer || !author) return 'not a writer';

  switch (op.type) {
    case 'set-format': {
      if (author.role !== 'manager') return 'only managers change the format';
      if (!isFormat(op.format) || op.format <= folder.format) return 'formats only rise';
      if (op.format > supported) host.interrupt(`folder format ${op.format}`);
      await view.put(FOLDER_KEY, { ...folder, format: op.format });
      return null;
    }
    case 'add-writer': {
      if (author.role !== 'manager') return 'only managers add writers';
      if (!folderIntroIsValid(op.member, deps)) return 'bad intro';
      if (await view.get(writerKey(op.member.writer))) return 'writer already in use';
      const { identity, name, device, writer: key, blobs } = op.member;
      const prior = await read<FolderPerson>(view, personKey(identity));
      const role: FolderRole = prior?.role ?? folder.role;
      if (role === 'reader') return 'readers do not write';
      await host.addWriter(Buffer.from(key, 'hex'), { indexer: role === 'manager' });
      await view.put(personKey(identity), { identity, name: prior?.name ?? name.trim(), role });
      await view.put(writerKey(key), { identity, device, blobs, writer: key });
      return null;
    }
    case 'set-role': {
      if (author.role !== 'manager') return 'only managers change roles';
      if (!isRole(op.role) || typeof op.identity !== 'string' || !HEX_KEY.test(op.identity)) return 'bad role';
      const target = await read<FolderPerson>(view, personKey(op.identity));
      // Someone who never wrote can still be given a role, so a reader can be made an editor.
      if (!target && !isName(op.name)) return 'a new person needs a name';
      const prior: FolderPerson = target ?? { identity: op.identity, name: op.name!.trim(), role: folder.role };
      if (prior.role === op.role && target) return null;
      if (prior.role === 'manager' && op.role !== 'manager' && (await managers(view)).length === 1) {
        return 'the last manager stays manager';
      }
      const keys = await writersOf(view, op.identity);
      if (op.role === 'reader' && keys.some((key) => !host.removeable(Buffer.from(key, 'hex')))) {
        return 'Autobase will not remove that writer';
      }
      for (const key of keys) {
        const buf = Buffer.from(key, 'hex');
        if (op.role === 'reader') {
          await host.removeWriter(buf);
          await view.del(writerKey(key));
        } else await host.addWriter(buf, { indexer: op.role === 'manager' });
      }
      await view.put(personKey(op.identity), { ...prior, role: op.role });
      return null;
    }
    case 'remove-person': {
      if (typeof op.identity !== 'string' || !HEX_KEY.test(op.identity)) return 'bad identity';
      // Managers remove anyone; anyone may remove themselves.
      if (author.role !== 'manager' && author.identity !== op.identity) return 'only managers remove others';
      const target = await read<FolderPerson>(view, personKey(op.identity));
      if (!target) return 'no such person';
      if (target.role === 'manager' && (await managers(view)).length === 1) return 'the last manager cannot be removed';
      const keys = await writersOf(view, op.identity);
      if (keys.some((key) => !host.removeable(Buffer.from(key, 'hex')))) return 'Autobase will not remove that writer';
      for (const key of keys) {
        await host.removeWriter(Buffer.from(key, 'hex'));
        await view.del(writerKey(key));
      }
      await view.del(personKey(op.identity));
      return null;
    }
    case 'put':
      return applyPut(op, view, writer, from, author);
    case 'del':
      return applyDel(op, view, from, author);
    default:
      return 'unknown operation';
  }
}

async function applyPut(
  op: Extract<FolderOp, { type: 'put' }>,
  view: FolderView,
  writer: FolderWriter,
  from: string,
  author: FolderPerson
): Promise<string | null> {
  if (author.role === 'reader') return 'readers do not write';
  const path = cleanPath(op.path);
  if (!path) return 'bad path';
  if (isNeverShared(path)) return 'path is never shared';
  if (!isCount(op.size) || op.size > MAX_FILE_BYTES) return 'bad size';
  if (typeof op.hash !== 'string' || !HEX_KEY.test(op.hash)) return 'bad hash';
  if (!isCount(op.at)) return 'bad time';
  if (op.base !== null && (!Number.isSafeInteger(op.base) || op.base < 1)) return 'bad base';
  const blob = cleanBlob(op.blob, op.size);
  // Contents come from the author's own blob core, which every reader knows from the writer record.
  if (!blob || blob.core !== writer.blobs) return 'bad blob';

  const current = await read<FolderFile>(view, fileKey(path));
  const file = (version: number, at: string, conflictOf?: string): FolderFile => ({
    path: at,
    version,
    deleted: false,
    blob,
    size: op.size,
    hash: op.hash,
    identity: author.identity,
    writer: from,
    at: op.at,
    ...(conflictOf ? { conflictOf } : {}),
  });

  // A new file, a change made from the current version, or a change to a deleted file: the edit
  // wins over the delete it crossed (ADR 0049 §7).
  if (!current || current.deleted || op.base === current.version) {
    await view.put(fileKey(path), file((current?.version ?? 0) + 1, current && !current.deleted ? current.path : path));
    return null;
  }
  // The change was made from an older version than the one ordered before it: keep it beside.
  for (let attempt = 1; ; attempt++) {
    const copy = conflictPath(current.path, author.name, attempt);
    if (Buffer.byteLength(copy) > MAX_PATH_BYTES) return 'conflict copy path too long';
    const existing = await read<FolderFile>(view, fileKey(copy));
    if (existing && !existing.deleted) continue;
    await view.put(fileKey(copy), file((existing?.version ?? 0) + 1, copy, current.path));
    return null;
  }
}

async function applyDel(
  op: Extract<FolderOp, { type: 'del' }>,
  view: FolderView,
  from: string,
  author: FolderPerson
): Promise<string | null> {
  if (author.role === 'reader') return 'readers do not write';
  const path = cleanPath(op.path);
  if (!path) return 'bad path';
  if (!isCount(op.at)) return 'bad time';
  const current = await read<FolderFile>(view, fileKey(path));
  if (!current || current.deleted) return 'no such file';
  // Someone changed it after the deleter last saw it: the change wins (ADR 0049 §7).
  if (op.base !== current.version) return 'file changed since';
  await view.put(fileKey(path), {
    path: current.path,
    version: current.version + 1,
    deleted: true,
    identity: author.identity,
    writer: from,
    at: op.at,
  } satisfies FolderFile);
  return null;
}
