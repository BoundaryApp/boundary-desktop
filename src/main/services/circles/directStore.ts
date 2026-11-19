/**
 * Where direct messages live on this Mac (ADR 0054 §1): one file per Circle, outside the Circles
 * store's single JSON file and outside the Circle's log, encrypted with the OS key as Circle
 * secrets are. A write goes to a temporary file first, so a crash leaves the last whole version.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encryptToBase64, tryDecryptFromBase64 } from '../secrets/osEncryption';
import type { DirectFile } from './directMessages';

const CIRCLE_KEY = /^[0-9a-f]{64}$/;
const SUFFIX = '.dm';

export interface DirectStore {
  keys(): Promise<string[]>;
  load(circleKey: string): Promise<DirectFile | null>;
  save(circleKey: string, file: DirectFile): Promise<void>;
  remove(circleKey: string): Promise<void>;
}

/** The store under `dir`. Throws on a key that isn't a Circle key, so no path can escape it. */
export function directStore(dir: string): DirectStore {
  const fileOf = (circleKey: string) => {
    if (!CIRCLE_KEY.test(circleKey)) throw new Error('That isn’t a Circle key.');
    return path.join(dir, circleKey + SUFFIX);
  };
  return {
    async keys() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      return names.filter((name) => name.endsWith(SUFFIX)).map((name) => name.slice(0, -SUFFIX.length)).filter((key) => CIRCLE_KEY.test(key));
    },
    async load(circleKey) {
      const file = fileOf(circleKey);
      let sealed: string;
      try {
        sealed = await readFile(file, 'utf8');
      } catch (error) {
        // Only a missing file is empty; any other failure must not let a save replace it.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      // No re-encrypt callback: the next save seals with the current key, in order with other saves.
      const json = await tryDecryptFromBase64(sealed);
      // Never replaced: the file stays as it is, and that Circle's DMs refuse until the keychain opens it.
      if (!json) throw new Error('This Mac’s keychain won’t open its direct messages.');
      const parsed = JSON.parse(json) as DirectFile;
      // A later build's file is left for that build, never overwritten by this one.
      if (parsed.version !== 1) throw new Error('These direct messages were saved by a newer Boundary.');
      return parsed;
    },
    async save(circleKey, value) {
      const file = fileOf(circleKey);
      await mkdir(dir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, await encryptToBase64(JSON.stringify(value)), { mode: 0o600 });
      await rename(temporary, file);
    },
    async remove(circleKey) {
      await rm(fileOf(circleKey), { force: true });
    },
  };
}
