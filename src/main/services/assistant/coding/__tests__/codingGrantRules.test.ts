import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codingGrantRefuseMessage,
  codingRootsFromPaths,
  envShadowTargets,
  folderFacts,
  refuseCodingGrantReason,
  serializeCodingExtraRoots,
  stackCheckoutDataDirs,
  stackDataMaskTargets,
  type CodingGrantRuleOptions,
} from '../codingGrantRules';

const HOME = '/Users/ana';
const USER_DATA = '/Users/ana/Library/Application Support/Boundary';
const STACK_HOME = '/Users/ana/stack-home';

function options(overrides: Partial<CodingGrantRuleOptions> = {}): CodingGrantRuleOptions {
  return {
    home: HOME,
    boundaryDataPaths: [USER_DATA, STACK_HOME],
    isDirectory: () => true,
    realpath: (candidate) => candidate,
    ...overrides,
  };
}

describe('refuseCodingGrantReason', () => {
  it('accepts a repo inside home', () => {
    expect(refuseCodingGrantReason('/Users/ana/Code/site', options())).toBeNull();
  });

  it('accepts a folder on an external volume (visibility is checked after mounting)', () => {
    expect(refuseCodingGrantReason('/Volumes/Work/client-api', options())).toBeNull();
  });

  it.each([
    ['relative', 'Code/site', 'not-absolute'],
    ['colon', '/Users/ana/Code/a:b', 'unsupported-characters'],
    ['newline', '/Users/ana/Code/a\nb', 'unsupported-characters'],
    ['root', '/', 'root'],
    ['home', '/Users/ana', 'home'],
    ['home with trailing slash', '/Users/ana/', 'home'],
    ['ancestor of home', '/Users', 'home-ancestor'],
    ['user Library', '/Users/ana/Library/Mail', 'system'],
    ['system folder', '/System/Library', 'system'],
    ['/usr', '/usr/local/src', 'system'],
    ['/private', '/private/tmp/x', 'system'],
    ['Applications', '/Applications/Example.app', 'system'],
    ['stack home', '/Users/ana/stack-home/project', 'boundary-data'],
    ['sibling of the stack home', '/Users/ana/stack-parent', null],
  ] as const)('%s', (_label, candidate, expected) => {
    expect(refuseCodingGrantReason(candidate, options())).toBe(expected);
  });

  it('refuses a folder that contains Boundary data', () => {
    expect(
      refuseCodingGrantReason('/Users/ana/Work', options({ boundaryDataPaths: ['/Users/ana/Work/boundary'] }))
    ).toBe('contains-boundary-data');
  });

  it('refuses a missing folder', () => {
    expect(
      refuseCodingGrantReason('/Users/ana/Code/gone', options({ isDirectory: () => false }))
    ).toBe('missing');
  });

  it('judges a symlink by where it lands', () => {
    expect(
      refuseCodingGrantReason(
        '/Users/ana/Code/link',
        options({ realpath: () => '/Users/ana/Library/Keychains' })
      )
    ).toBe('system');
  });

  it('has a message for every reason', () => {
    for (const reason of [
      'not-absolute',
      'unsupported-characters',
      'root',
      'home',
      'home-ancestor',
      'system',
      'boundary-data',
      'contains-boundary-data',
      'missing',
    ] as const) {
      expect(codingGrantRefuseMessage(reason)).toMatch(/\S/);
    }
  });
});

describe('codingRootsFromPaths', () => {
  it('dedupes, drops paths inside another root, and sorts', () => {
    expect(
      codingRootsFromPaths([
        '/Users/ana/Code/b',
        '/Users/ana/Code/a',
        '/Users/ana/Code/a/packages/web',
        '/Users/ana/Code/b/',
        '/Users/ana/Code/ab',
      ])
    ).toEqual(['/Users/ana/Code/a', '/Users/ana/Code/ab', '/Users/ana/Code/b']);
  });
});

describe('serializeCodingExtraRoots', () => {
  it('prefixes a colon, because the stack appends it to HERMES_WRITE_SAFE_ROOT', () => {
    expect(serializeCodingExtraRoots(['/a', '/b'])).toBe(':/a:/b');
  });

  it('is empty with no roots', () => {
    expect(serializeCodingExtraRoots([])).toBe('');
  });
});

describe('envShadowTargets', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists top-level .env files and skips templates, folders and nested files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-env-'));
    temps.push(dir);
    for (const name of ['.env', '.env.local', '.env.production', '.env.example', '.env.sample', '.env.template', '.envrc', 'env']) {
      fs.writeFileSync(path.join(dir, name), 'X=1');
    }
    fs.mkdirSync(path.join(dir, '.env.d'));
    fs.mkdirSync(path.join(dir, 'api'));
    fs.writeFileSync(path.join(dir, 'api', '.env'), 'X=1');
    expect(envShadowTargets(dir)).toEqual([
      path.join(dir, '.env'),
      path.join(dir, '.env.local'),
      path.join(dir, '.env.production'),
    ]);
  });

  it('returns nothing for an unreadable folder', () => {
    expect(envShadowTargets('/definitely/not/here')).toEqual([]);
  });
});

describe('stackCheckoutDataDirs', () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function checkout(dir: string): void {
    fs.mkdirSync(path.join(dir, 'data', 'hermes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  }

  function tempRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-stack-'));
    temps.push(dir);
    return dir;
  }

  it('finds checkouts at the root and up to two levels below it', () => {
    const root = tempRoot();
    checkout(root);
    checkout(path.join(root, 'assistant'));
    checkout(path.join(root, 'work', 'stack'));
    checkout(path.join(root, 'a', 'b', 'too-deep'));
    expect(stackCheckoutDataDirs(root)).toEqual(
      [
        path.join(root, 'assistant', 'data'),
        path.join(root, 'data'),
        path.join(root, 'work', 'stack', 'data'),
      ].sort((a, b) => a.localeCompare(b))
    );
  });

  it('needs both docker-compose.yml and data/hermes', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'compose-only'));
    fs.writeFileSync(path.join(root, 'compose-only', 'docker-compose.yml'), '');
    fs.mkdirSync(path.join(root, 'data-only', 'data', 'hermes'), { recursive: true });
    expect(stackCheckoutDataDirs(root)).toEqual([]);
  });

  it('skips node_modules, .git and worktrees folders, as make doctor does', () => {
    const root = tempRoot();
    checkout(path.join(root, 'node_modules', 'pkg'));
    checkout(path.join(root, '.git', 'x'));
    checkout(path.join(root, 'worktrees', 'branch'));
    expect(stackCheckoutDataDirs(root)).toEqual([]);
  });

  it('returns nothing for an unreadable folder', () => {
    expect(stackCheckoutDataDirs('/definitely/not/here')).toEqual([]);
  });
});

describe('stackDataMaskTargets', () => {
  const dirs = ['/Users/me/Code/assistant/data', '/Users/me/Other/stack/data'];

  it('maps a checkout under an identity bind to its host path', () => {
    expect(stackDataMaskTargets('/Users/me/Code', '/Users/me/Code', dirs)).toEqual([
      '/Users/me/Code/assistant/data',
    ]);
  });

  it('maps a checkout under a project bind to the container path', () => {
    expect(
      stackDataMaskTargets('/Users/me/Code/assistant', '/opt/projects/assistant', dirs)
    ).toEqual(['/opt/projects/assistant/data']);
  });

  it('ignores checkouts outside the bind and a bind of the data folder itself', () => {
    expect(stackDataMaskTargets('/Users/me/Elsewhere', '/x', dirs)).toEqual([]);
    expect(
      stackDataMaskTargets('/Users/me/Code/assistant/data', '/x', dirs)
    ).toEqual([]);
  });
});

describe('folderFacts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a directory and its .git', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-facts-'));
    dirs.push(dir);
    expect(folderFacts(dir)).toEqual({ isDirectory: true, isGit: false });
    fs.mkdirSync(path.join(dir, '.git'));
    expect(folderFacts(dir)).toEqual({ isDirectory: true, isGit: true });
  });

  it('is neither for a file or a missing path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-facts-'));
    dirs.push(dir);
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'x');
    expect(folderFacts(file)).toEqual({ isDirectory: false, isGit: false });
    expect(folderFacts(path.join(dir, 'missing'))).toEqual({ isDirectory: false, isGit: false });
  });
});
