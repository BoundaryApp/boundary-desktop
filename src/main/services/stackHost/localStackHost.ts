import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ALL_STACK_CAPABILITIES } from '../../../shared/stackCapabilities';
import type { AssistantStackPorts } from '../../../shared/types/assistantStack';
import type { StackCommands, StackEndpoints, StackFiles, StackHost, StackLocation } from './types';

export interface LocalStackHostDeps extends LocalStackRoots {
  /** Read on each call, since Boundary can pick a new port set while it runs. */
  ports: () => AssistantStackPorts;
  commands: StackCommands;
}

/** Each published port is on this machine's loopback, under the same number. */
export function localStackEndpoints(ports: () => AssistantStackPorts): StackEndpoints {
  const portUrl: StackEndpoints['portUrl'] = (stackPort, urlPath = '', hostname = '127.0.0.1') =>
    `http://${hostname}:${stackPort}${urlPath}`;
  return {
    port: (key) => ports()[key],
    url: (key, urlPath) => portUrl(ports()[key], urlPath),
    portUrl,
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** Replaces `file` in one step, creating its folder. An existing file keeps its mode. */
async function writeAtomic(file: string, contents: string | Uint8Array, newMode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await fs.stat(file)).mode & 0o7777;
  } catch (error) {
    if (!isMissing(error)) throw error;
    mode = newMode;
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, contents, typeof contents === 'string' ? { encoding: 'utf8', mode } : { mode });
    if (mode !== undefined) await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export interface LocalStackRoots {
  /** The stack's compose folder. */
  stackRoot: string;
  /** Read on each call, since `ASSISTANT_DATA_ROOT` in the stack's `.env` can change. */
  userContentRoot: () => string;
}

/** Stack files as files under the stack's folders on this machine. */
export function localStackFiles(deps: LocalStackRoots): StackFiles {
  const dataRoot = path.join(deps.stackRoot, 'data');

  const base = (location: StackLocation): string => {
    if (location === 'stack') return deps.stackRoot;
    if (location === 'data') return dataRoot;
    return deps.userContentRoot();
  };

  const resolve = (location: StackLocation, relPath: string): string => {
    if (path.isAbsolute(relPath)) {
      throw new Error(`Stack file path must be relative to ${location}: ${relPath}`);
    }
    const root = base(location);
    const full = path.resolve(root, relPath);
    const rel = path.relative(root, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Stack file path is outside ${location}: ${relPath}`);
    }
    return full;
  };

  return {
    async readText(location, relPath) {
      try {
        return await fs.readFile(resolve(location, relPath), 'utf8');
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    writeText: async (location, relPath, contents, options = {}) =>
      writeAtomic(resolve(location, relPath), contents, options.mode),
    writeBytes: async (location, relPath, data, options = {}) =>
      writeAtomic(resolve(location, relPath), data, options.mode),
    async exists(location, relPath) {
      try {
        await fs.access(resolve(location, relPath));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async stat(location, relPath) {
      try {
        const st = await fs.stat(resolve(location, relPath));
        if (st.isFile()) return { kind: 'file', size: st.size };
        return { kind: st.isDirectory() ? 'folder' : 'other', size: 0 };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async realpath(location, relPath) {
      let real: string;
      let realRoot: string;
      try {
        real = await fs.realpath(resolve(location, relPath));
        realRoot = await fs.realpath(base(location));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      const rel = path.relative(realRoot, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel.split(path.sep).join('/');
    },
    async list(location, relPath) {
      try {
        return await fs.readdir(resolve(location, relPath));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async mkdir(location, relPath, options = {}) {
      await fs.mkdir(resolve(location, relPath), { recursive: true, mode: options.mode });
    },
    async rename(location, from, to) {
      await fs.rename(resolve(location, from), resolve(location, to));
    },
    async remove(location, relPath) {
      const full = resolve(location, relPath);
      if (full === base(location)) {
        throw new Error(`Refusing to remove the ${location} folder itself`);
      }
      await fs.rm(full, { recursive: true, force: true });
    },
  };
}

/** The stack as folders, processes and loopback ports on this machine (ADR 0062 §2). */
export function createLocalStackHost(deps: LocalStackHostDeps): StackHost {
  return {
    kind: 'local',
    commands: deps.commands,
    files: localStackFiles(deps),
    endpoints: localStackEndpoints(deps.ports),
    capabilities: { ...ALL_STACK_CAPABILITIES },
    localPaths: { stack: deps.stackRoot, data: path.join(deps.stackRoot, 'data') },
  };
}
