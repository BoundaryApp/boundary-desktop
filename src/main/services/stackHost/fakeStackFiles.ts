import path from 'node:path';
import type { StackFiles, StackLocation } from './types';

/** Stack files held in memory for tests, keyed `<location>:<relative path>`. */
export interface FakeStackFiles extends StackFiles {
  /** Files by `<location>:<relative path>`. Tests may read and change it. */
  files: Map<string, string>;
  /** Mode asked for when each file or folder was created, by the same key. */
  modes: Map<string, number>;
}

function key(location: StackLocation, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new Error(`Stack file path must be relative to ${location}: ${relPath}`);
  const norm = path.posix.normalize(relPath.split(path.sep).join('/')).replace(/\/+$/, '');
  if (norm === '..' || norm.startsWith('../')) throw new Error(`Stack file path is outside ${location}: ${relPath}`);
  return `${location}:${norm === '.' ? '' : norm}`;
}

/**
 * A `StackFiles` over a map, with the same path rules as the local host. It has no links, and
 * keeps bytes as UTF-8 text.
 */
export function createFakeStackFiles(initial: Record<string, string> = {}): FakeStackFiles {
  const files = new Map(Object.entries(initial));
  const folders = new Set<string>();
  const modes = new Map<string, number>();
  const under = (folder: string) => (folder.endsWith(':') ? folder : `${folder}/`);
  const hasUnder = (folder: string) =>
    [...files.keys(), ...folders].some((k) => k.startsWith(under(folder)));
  const isFolder = (k: string) => k.endsWith(':') || folders.has(k) || hasUnder(k);
  return {
    files,
    modes,
    async readText(location, relPath) {
      return files.get(key(location, relPath)) ?? null;
    },
    async writeText(location, relPath, contents, options = {}) {
      const k = key(location, relPath);
      if (!files.has(k) && options.mode !== undefined) modes.set(k, options.mode);
      files.set(k, contents);
    },
    async writeBytes(location, relPath, data, options = {}) {
      const k = key(location, relPath);
      if (!files.has(k) && options.mode !== undefined) modes.set(k, options.mode);
      files.set(k, new TextDecoder().decode(data));
    },
    async exists(location, relPath) {
      const k = key(location, relPath);
      return files.has(k) || isFolder(k);
    },
    async stat(location, relPath) {
      const k = key(location, relPath);
      const text = files.get(k);
      if (text !== undefined) return { kind: 'file', size: new TextEncoder().encode(text).length };
      return isFolder(k) ? { kind: 'folder', size: 0 } : null;
    },
    async realpath(location, relPath) {
      const k = key(location, relPath);
      return files.has(k) || isFolder(k) ? k.slice(k.indexOf(':') + 1) : null;
    },
    async list(location, relPath) {
      const folder = key(location, relPath);
      if (!isFolder(folder)) return null;
      const names = new Set<string>();
      for (const k of [...files.keys(), ...folders]) {
        if (k.startsWith(under(folder))) names.add(k.slice(under(folder).length).split('/')[0]);
      }
      return [...names].sort();
    },
    async mkdir(location, relPath, options = {}) {
      const k = key(location, relPath);
      if (!isFolder(k) && options.mode !== undefined) modes.set(k, options.mode);
      folders.add(k);
    },
    async rename(location, from, to) {
      const src = key(location, from);
      const dest = key(location, to);
      if (!files.has(src) && !isFolder(src)) throw new Error(`No such stack file: ${from}`);
      const move = (k: string) => (k === src ? dest : `${dest}${k.slice(src.length)}`);
      const inside = (k: string) => k === src || k.startsWith(`${src}/`);
      for (const k of [...files.keys()].filter(inside)) {
        files.set(move(k), files.get(k) as string);
        files.delete(k);
      }
      for (const k of [...folders].filter(inside)) {
        folders.add(move(k));
        folders.delete(k);
      }
    },
    async remove(location, relPath) {
      const k = key(location, relPath);
      if (k.endsWith(':')) throw new Error(`Refusing to remove the ${location} folder itself`);
      files.delete(k);
      folders.delete(k);
      for (const other of [...files.keys()]) if (other.startsWith(`${k}/`)) files.delete(other);
      for (const other of [...folders]) if (other.startsWith(`${k}/`)) folders.delete(other);
    },
  };
}
