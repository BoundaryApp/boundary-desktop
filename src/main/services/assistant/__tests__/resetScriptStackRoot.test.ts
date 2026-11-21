import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// scripts/reset-boundary-dev-state.sh decides what to delete with a bash copy of stackMode().
// These cases run that copy and stackMode() on the same env and stored override and require
// the same answer. The script itself is never run: it deletes folders.

let storedOverride: string | null = null;
let managedRoot = '';

vi.mock('../AssistantStackStore', () => ({
  getAssistantRootOverride: () => storedOverride,
}));
vi.mock('../assistantPaths', () => ({
  resolveAssistantProjectRoot: () => managedRoot,
}));

import { resetStackModeCacheForTests, stackMode } from '../localStackMode';
import { canonicalPath } from '../../hostPaths';

const SCRIPT = path.resolve(__dirname, '../../../../../scripts/reset-boundary-dev-state.sh');

function extractBlock(): string {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const m = /^# BEGIN local_stack_root\n([\s\S]*?)^# END local_stack_root$/m.exec(text);
  if (!m) throw new Error('local_stack_root markers missing from reset-boundary-dev-state.sh');
  return m[1];
}

let dir: string;
let support: string;

/** Runs the block the way the script does (set -euo pipefail) and returns its stdout. */
function runBash(env: Record<string, string | undefined>, cwd = dir) {
  const r = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nSUPPORT="$1"\n${extractBlock()}\nlocal_stack_root`, 'bash', support],
    {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        BOUNDARY_ASSISTANT_ROOT: env.BOUNDARY_ASSISTANT_ROOT,
        BOUNDARY_LOCAL_STACK: env.BOUNDARY_LOCAL_STACK,
      },
    },
  );
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

function writeStore(contents: string) {
  fs.writeFileSync(path.join(support, 'assistant-stack.json'), contents);
}

describe('reset script local_stack_root agrees with stackMode()', () => {
  let checkout: string;
  let other: string;

  beforeEach(() => {
    vi.stubEnv('BOUNDARY_LOCAL_STACK', undefined);
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', undefined);
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reset-root-')));
    support = path.join(dir, 'Support');
    managedRoot = path.join(support, 'assistant-stack', 'project');
    fs.mkdirSync(managedRoot, { recursive: true });
    checkout = path.join(dir, 'checkout');
    other = path.join(dir, 'other');
    fs.mkdirSync(checkout);
    fs.mkdirSync(other);
    storedOverride = null;
    resetStackModeCacheForTests();
  });

  afterEach(() => {
    resetStackModeCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    env?: (d: { checkout: string; other: string; managed: string }) => string | undefined;
    stored?: (d: { checkout: string; other: string; managed: string }) => string;
    liveFlag?: boolean;
  }> = [
    { name: 'nothing set' },
    { name: 'BOUNDARY_LOCAL_STACK=1 alone', liveFlag: true },
    { name: 'BOUNDARY_ASSISTANT_ROOT alone', env: (d) => d.checkout },
    { name: 'flag and root', liveFlag: true, env: (d) => d.checkout },
    { name: 'stored override', stored: (d) => d.checkout },
    { name: 'env root wins over stored', env: (d) => d.checkout, stored: (d) => d.other },
    { name: 'stored override naming the managed install', stored: (d) => d.managed },
    { name: 'env root naming the managed install with a trailing slash', liveFlag: true, env: (d) => `${d.managed}/` },
    { name: 'whitespace-only env falls through to the stored override', env: () => '   ', stored: (d) => d.checkout },
    { name: 'whitespace around the root', env: (d) => `  ${d.checkout}  ` },
    { name: 'root that does not exist yet', env: (d) => path.join(d.checkout, 'missing') },
    { name: 'root with a trailing slash', env: (d) => `${d.checkout}/` },
    { name: 'stored root reached through a symlink to the managed install', stored: (d) => {
      const link = path.join(dir, 'link-to-managed');
      fs.symlinkSync(d.managed, link);
      return link;
    } },
    { name: 'env root reached through a symlink to a checkout', env: (d) => {
      const link = path.join(dir, 'link-to-checkout');
      fs.symlinkSync(d.checkout, link);
      return link;
    } },
  ];

  // The script reads the store file with plutil, which only macOS has. Elsewhere it never
  // sees a stored override, so cases that write one run on macOS only.
  const storeCases = cases.filter((c) => c.stored);
  const envCases = cases.filter((c) => !c.stored);

  const check = ({ env, stored, liveFlag }: (typeof cases)[number]) => {
    const d = { checkout, other, managed: managedRoot };
    const envRoot = env?.(d);
    const storedRoot = stored?.(d);
    if (liveFlag) vi.stubEnv('BOUNDARY_LOCAL_STACK', '1');
    if (envRoot !== undefined) vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', envRoot);
    storedOverride = storedRoot?.trim() ? storedRoot.trim() : null;
    if (storedRoot !== undefined) writeStore(JSON.stringify({ assistantRootOverride: storedRoot }));

    const ts = stackMode();
    const sh = runBash({
      BOUNDARY_ASSISTANT_ROOT: envRoot,
      BOUNDARY_LOCAL_STACK: liveFlag ? '1' : undefined,
    });

    expect(sh.status).toBe(0);
    // Empty output is the managed stack; the script then resets. Anything else blocks it.
    expect(sh.stdout === '' ? 'managed' : 'local').toBe(ts.kind);
    if (ts.kind === 'local') expect(sh.stdout).toBe(canonicalPath(ts.root));
  };

  it.each(envCases)('$name', check);
  it.skipIf(process.platform !== 'darwin').each(storeCases)('$name', check);

  it('resolves a relative root against the working directory, as path.resolve does', () => {
    vi.stubEnv('BOUNDARY_ASSISTANT_ROOT', 'checkout/missing');
    const ts = stackMode();
    const sh = runBash({ BOUNDARY_ASSISTANT_ROOT: 'checkout/missing' });
    // stackMode() resolves against the test's cwd, bash against `dir`; compare the shape.
    expect(ts.kind).toBe('local');
    expect(sh.stdout).toBe(path.join(dir, 'checkout', 'missing'));
  });

  // Missing input and failure: the block must not abort the script under `set -e`.
  it('treats a missing store file as the managed stack and exits 0', () => {
    const sh = runBash({});
    expect(sh).toMatchObject({ status: 0, stdout: '' });
  });

  it('treats an unreadable store file as the managed stack and exits 0', () => {
    writeStore('{not json');
    const sh = runBash({});
    expect(sh).toMatchObject({ status: 0, stdout: '' });
  });

  it('ignores a store without assistantRootOverride', () => {
    writeStore(JSON.stringify({ n8nEnabled: true }));
    expect(runBash({})).toMatchObject({ status: 0, stdout: '' });
  });

  it('fails loudly when the markers are gone', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('# BEGIN local_stack_root');
    expect(text).toContain('# END local_stack_root');
  });
});
