/**
 * Stands in for the coding grant deps (`CodingGrantDeps`): no compose, git, Trash or audit log.
 * `fakeCodingDeps` installs the fakes with `setCodingGrantDepsForTests` and returns what they
 * were called with. Tests reset with `setCodingGrantDepsForTests(null)`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditEntry } from '../../../hostBridge/auditLog';
import { setCodingGrantDepsForTests, type CodingGrantDeps } from '../codingGrants';

/** Create `root/...parts` (and its parents) and return its path. */
export function makeFolder(root: string, ...parts: string[]): string {
  const dir = path.join(root, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** What `gitOutput` answers per subcommand. Unset fields answer a clean repo with a remote. */
export interface GitAnswers {
  status?: string;
  remote?: string;
  unpushed?: string;
  total?: string;
  diffTree?: string;
}

export interface FakeCodingDepsOptions {
  /** The fake home folder `ruleOptions` reports. */
  home: string;
  /** Boundary's own data folders for `ruleOptions`. Defaults to `<home>/boundary`. */
  boundaryDataPaths?: string[];
  git?: GitAnswers;
  overrides?: Partial<CodingGrantDeps>;
}

export interface CodingDepCalls {
  recreate: number;
  persisted: string[][];
  verified: string[];
  git: string[][];
  audit: AuditEntry[];
  /** Recreates and moves to the Trash in the order they ran: `recreate`, `trash:<path>`. */
  order: string[];
}

/**
 * Install fakes for every dep: a remote stack, an idle coding agent, recreates and checks that
 * succeed. `overrides` replace single deps; the counters only see the fakes they replace.
 */
export function fakeCodingDeps({
  home,
  boundaryDataPaths = [path.join(home, 'boundary')],
  git = {},
  overrides = {},
}: FakeCodingDepsOptions): CodingDepCalls {
  const calls: CodingDepCalls = {
    recreate: 0,
    persisted: [],
    verified: [],
    git: [],
    audit: [],
    order: [],
  };
  const deps: Partial<CodingGrantDeps> = {
    isLocalStack: () => false,
    busy: async () => ({ busy: false, sessions: [] }),
    writeOverlay: () => undefined,
    persistEnv: (roots) => {
      calls.persisted.push([...roots]);
    },
    recreate: async () => {
      calls.recreate += 1;
      calls.order.push('recreate');
      return { success: true };
    },
    verify: async (hostPath) => {
      calls.verified.push(hostPath);
      return true;
    },
    restartHermes: async () => ({ success: true }),
    ruleOptions: () => ({ home, boundaryDataPaths, systemFolders: [] }),
    runGit: async (_cwd, args) => {
      calls.git.push(args);
    },
    gitOutput: async (_cwd, args) => {
      if (args[0] === 'status') return git.status ?? '';
      if (args[0] === 'remote') return git.remote ?? 'origin';
      if (args[0] === 'rev-list' && args.includes('--not')) return git.unpushed ?? '0';
      if (args[0] === 'rev-list') return git.total ?? '5';
      if (args[0] === 'diff-tree') return git.diffTree ?? 'README.md';
      return '';
    },
    trash: async (hostPath) => {
      calls.order.push(`trash:${hostPath}`);
    },
    progress: () => undefined,
    audit: (entry) => {
      calls.audit.push(entry);
    },
    ...overrides,
  };
  setCodingGrantDepsForTests(deps);
  return calls;
}
