import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { StackFiles, StackLocation } from './types';

const posix = path.posix;

/** What `stat` and `lstat` give back: enough for the stack files. */
export interface SftpStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mode: number;
}

/**
 * The SFTP calls the stack files make, as promises over absolute POSIX paths on the host.
 * `sftpOps` (sshConnection.ts) adapts ssh2's client. A missing path rejects with an error whose
 * `code` is 2 (SFTP's NO_SUCH_FILE) or `ENOENT`.
 */
export interface SftpOps {
  readFile(file: string): Promise<Buffer>;
  /** Creates or truncates `file`; `mode` applies when it is created. */
  writeFile(file: string, data: Buffer, mode?: number): Promise<void>;
  stat(file: string): Promise<SftpStat>;
  lstat(file: string): Promise<SftpStat>;
  realpath(file: string): Promise<string>;
  /** Entry names, without `.` and `..`. */
  readdir(folder: string): Promise<string[]>;
  mkdir(folder: string, mode?: number): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  /** Replaces `to` when it is a file, as rename(2) does (`posix-rename@openssh.com`). */
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  rmdir(folder: string): Promise<void>;
}

function isSftpMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 2 || code === 'ENOENT';
}

export interface RemoteStackRoots {
  /** The stack's compose folder on the host, absolute. */
  stackRoot: string;
  /** The folder `ASSISTANT_DATA_ROOT` names on the host, absolute; read on each call. */
  userContentRoot: () => Promise<string>;
}

/** Stack files on a host reached over SFTP (remote stack plan, phase 4). */
export function sftpStackFiles(sftp: SftpOps, roots: RemoteStackRoots): StackFiles {
  const dataRoot = posix.join(roots.stackRoot, 'data');

  const base = async (location: StackLocation): Promise<string> => {
    if (location === 'stack') return roots.stackRoot;
    if (location === 'data') return dataRoot;
    return roots.userContentRoot();
  };

  const resolve = async (location: StackLocation, relPath: string): Promise<string> => {
    if (posix.isAbsolute(relPath) || path.isAbsolute(relPath)) {
      throw new Error(`Stack file path must be relative to ${location}: ${relPath}`);
    }
    const root = await base(location);
    const full = posix.resolve(root, relPath.split(path.sep).join('/'));
    const rel = posix.relative(root, full);
    if (rel.startsWith('..') || posix.isAbsolute(rel)) {
      throw new Error(`Stack file path is outside ${location}: ${relPath}`);
    }
    return full;
  };

  const statOrNull = async (file: string, follow = true): Promise<SftpStat | null> => {
    try {
      return await (follow ? sftp.stat(file) : sftp.lstat(file));
    } catch (error) {
      if (isSftpMissing(error)) return null;
      throw error;
    }
  };

  /** Makes `folder` and its missing parents; `mode` applies to the ones it makes. */
  const mkdirs = async (folder: string, mode?: number): Promise<void> => {
    const existing = await statOrNull(folder);
    if (existing) {
      if (!existing.isDirectory()) throw new Error(`Not a folder: ${folder}`);
      return;
    }
    const parent = posix.dirname(folder);
    if (parent !== folder) await mkdirs(parent, mode);
    try {
      await sftp.mkdir(folder, mode);
    } catch (error) {
      // Another writer made it in the meantime.
      if (!(await statOrNull(folder))?.isDirectory()) throw error;
    }
  };

  const writeAtomic = async (file: string, data: Buffer, newMode?: number): Promise<void> => {
    await mkdirs(posix.dirname(file));
    const existing = await statOrNull(file);
    const mode = existing ? existing.mode & 0o7777 : newMode;
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await sftp.writeFile(temp, data, mode);
      if (mode !== undefined) await sftp.chmod(temp, mode);
      await sftp.rename(temp, file);
    } catch (error) {
      await sftp.unlink(temp).catch((): void => undefined);
      throw error;
    }
  };

  /** Deletes without following links: a link to a folder goes, the folder stays. */
  const removeTree = async (file: string): Promise<void> => {
    const st = await statOrNull(file, false);
    if (!st) return;
    if (st.isDirectory() && !st.isSymbolicLink()) {
      for (const name of await sftp.readdir(file)) await removeTree(posix.join(file, name));
      await sftp.rmdir(file);
      return;
    }
    try {
      await sftp.unlink(file);
    } catch (error) {
      if (!isSftpMissing(error)) throw error;
    }
  };

  return {
    async readText(location, relPath) {
      try {
        return (await sftp.readFile(await resolve(location, relPath))).toString('utf8');
      } catch (error) {
        if (isSftpMissing(error)) return null;
        throw error;
      }
    },
    writeText: async (location, relPath, contents, options = {}) =>
      writeAtomic(await resolve(location, relPath), Buffer.from(contents, 'utf8'), options.mode),
    writeBytes: async (location, relPath, data, options = {}) =>
      writeAtomic(await resolve(location, relPath), Buffer.from(data), options.mode),
    exists: async (location, relPath) => (await statOrNull(await resolve(location, relPath))) !== null,
    async stat(location, relPath) {
      const st = await statOrNull(await resolve(location, relPath));
      if (!st) return null;
      if (st.isFile()) return { kind: 'file', size: st.size };
      return { kind: st.isDirectory() ? 'folder' : 'other', size: 0 };
    },
    async realpath(location, relPath) {
      const full = await resolve(location, relPath);
      if (!(await statOrNull(full))) return null;
      let real: string;
      let realRoot: string;
      try {
        [real, realRoot] = await Promise.all([sftp.realpath(full), sftp.realpath(await base(location))]);
      } catch (error) {
        if (isSftpMissing(error)) return null;
        throw error;
      }
      const rel = posix.relative(realRoot, real);
      if (rel.startsWith('..') || posix.isAbsolute(rel)) return null;
      return rel;
    },
    async list(location, relPath) {
      try {
        return await sftp.readdir(await resolve(location, relPath));
      } catch (error) {
        if (isSftpMissing(error)) return null;
        throw error;
      }
    },
    mkdir: async (location, relPath, options = {}) => mkdirs(await resolve(location, relPath), options.mode),
    rename: async (location, from, to) => sftp.rename(await resolve(location, from), await resolve(location, to)),
    async remove(location, relPath) {
      const full = await resolve(location, relPath);
      if (full === (await base(location))) {
        throw new Error(`Refusing to remove the ${location} folder itself`);
      }
      await removeTree(full);
    },
  };
}
