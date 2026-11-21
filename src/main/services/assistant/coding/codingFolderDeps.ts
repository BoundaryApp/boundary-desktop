import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shell } from 'electron';

/**
 * Git and Trash effects for the folder features built on coding grants: New folder…, and
 * deleting a folder Boundary created. Grants themselves use `CodingGrantDeps`.
 */

const execFileAsync = promisify(execFile);

export interface CodingFolderDeps {
  runGit: (cwd: string, args: string[]) => Promise<void>;
  /** Run git and return trimmed stdout. */
  gitOutput: (cwd: string, args: string[]) => Promise<string>;
  gitAvailable: () => Promise<boolean>;
  /** Move a path to the macOS Trash. Never deletes permanently. */
  trash: (hostPath: string) => Promise<void>;
}

const defaultDeps: CodingFolderDeps = {
  runGit: async (cwd, args) => {
    await execFileAsync('git', args, { cwd, timeout: 30_000 });
  },
  gitOutput: async (cwd, args) => {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 30_000 });
    return String(stdout).trim();
  },
  trash: (hostPath) => shell.trashItem(hostPath),
  gitAvailable: async () => {
    try {
      await execFileAsync('git', ['--version'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  },
};

let deps: CodingFolderDeps = defaultDeps;

/** The git and Trash effects in use. */
export function codingFolderDeps(): CodingFolderDeps {
  return deps;
}

/** Test-only: swap side effects. */
export function setCodingFolderDepsForTests(next: Partial<CodingFolderDeps> | null): void {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps;
}
