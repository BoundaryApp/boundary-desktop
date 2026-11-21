import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeProjectSwap,
  recoverInterruptedProjectSwap,
  swapProjectTreePreservingData,
  type ProjectSwapPaths,
} from '../projectTreeSwap';

let home: string;
let paths: ProjectSwapPaths;

function write(root: string, rel: string, body: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function read(root: string, rel: string): string | null {
  const file = path.join(root, rel);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-'));
  paths = {
    projectRoot: path.join(home, 'project'),
    nextRoot: path.join(home, '.staging', 'extract', 'stack'),
    previousRoot: path.join(home, 'project.previous'),
    journalPath: path.join(home, '.upgrade.json'),
  };
  // The live tree: old stack code plus the user's data and secrets.
  write(paths.projectRoot, 'docker-compose.yml', 'old compose');
  write(paths.projectRoot, 'scripts/setup.sh', 'old setup');
  write(paths.projectRoot, 'data/hermes/profiles/default/vault/vault.enc', 'logins');
  write(paths.projectRoot, 'data/hermes/state.db', 'chats');
  write(paths.projectRoot, '.env', 'SECRET=keep');
  write(paths.projectRoot, 'compose/hermes/api-server.env', 'API=keep');
  write(paths.projectRoot, 'compose/hermes/worker/ssh/id_ed25519', 'WORKER_KEY=keep');
  write(paths.projectRoot, 'compose/hermes/worker/ssh/.gitkeep', '');
  write(paths.projectRoot, 'searxng/settings.local.yml', 'searx secret');
  // The new archive: new code, tracked placeholders, no data.
  write(paths.nextRoot, 'docker-compose.yml', 'new compose');
  write(paths.nextRoot, 'scripts/setup.sh', 'new setup');
  write(paths.nextRoot, 'compose/hermes/worker/ssh/.gitkeep', '');
  write(paths.nextRoot, 'compose/hermes/worker/README.md', 'example');
  write(paths.nextRoot, '.env.example', 'NEW_KEY=');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Every file and folder under `root`, with file contents. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full);
      if (fs.lstatSync(full).isDirectory()) {
        out[`${rel}/`] = '';
        walk(full);
      } else {
        out[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(root);
  return out;
}

const SWAP_FS_CALLS = ['rename', 'rm', 'mkdir', 'cp', 'writeFile'] as const;

/**
 * Count the fs.promises calls the swap makes, and make call number `failAt` (1-based)
 * throw. Returns the counter so a test can read the total.
 */
function instrumentFs(failAt: number | null, alsoFail?: (call: number) => boolean) {
  const state = { calls: 0 };
  for (const name of SWAP_FS_CALLS) {
    const real = (fs.promises[name] as (...args: unknown[]) => Promise<unknown>).bind(fs.promises);
    vi.spyOn(fs.promises, name).mockImplementation((async (...args: unknown[]) => {
      state.calls += 1;
      if (state.calls === failAt || alsoFail?.(state.calls)) {
        throw Object.assign(new Error(`simulated ${name} failure`), { code: 'EIO' });
      }
      return real(...args);
    }) as never);
  }
  return state;
}

describe('swapProjectTreePreservingData', () => {
  it('puts the new code in place and keeps data and secrets', async () => {
    await swapProjectTreePreservingData(paths);

    const live = paths.projectRoot;
    expect(read(live, 'docker-compose.yml')).toBe('new compose');
    expect(read(live, 'scripts/setup.sh')).toBe('new setup');
    expect(read(live, '.env.example')).toBe('NEW_KEY=');
    expect(read(live, 'data/hermes/profiles/default/vault/vault.enc')).toBe('logins');
    expect(read(live, 'data/hermes/state.db')).toBe('chats');
    expect(read(live, '.env')).toBe('SECRET=keep');
    expect(read(live, 'compose/hermes/api-server.env')).toBe('API=keep');
    expect(read(live, 'compose/hermes/worker/ssh/id_ed25519')).toBe('WORKER_KEY=keep');
    expect(read(live, 'compose/hermes/worker/README.md')).toBe('example');
    expect(read(live, 'searxng/settings.local.yml')).toBe('searx secret');
    expect(fs.existsSync(paths.journalPath)).toBe(false);
    expect(fs.existsSync(paths.nextRoot)).toBe(false);
  });

  it('keeps the old code, without its data, as project.previous', async () => {
    await swapProjectTreePreservingData(paths);
    expect(read(paths.previousRoot, 'docker-compose.yml')).toBe('old compose');
    expect(fs.existsSync(path.join(paths.previousRoot, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(paths.previousRoot, '.env'))).toBe(false);
  });

  it('adds files only the new tree has inside a carried-over folder', async () => {
    write(paths.nextRoot, 'compose/hermes/worker/ssh/README.md', 'new readme');
    await swapProjectTreePreservingData(paths);
    const live = paths.projectRoot;
    expect(read(live, 'compose/hermes/worker/ssh/README.md')).toBe('new readme');
    expect(read(live, 'compose/hermes/worker/ssh/id_ed25519')).toBe('WORKER_KEY=keep');
    expect(fs.existsSync(path.join(live, 'compose/hermes/worker/ssh.boundary-fresh'))).toBe(
      false
    );
  });

  it('keeps llm-proxy model defaults, and leaves unread Twenty and CalDAV account files with the old tree', async () => {
    write(paths.projectRoot, 'compose/twenty/workspaces/main.env', 'TWENTY_KEY_RW=old');
    write(paths.projectRoot, 'compose/caldav-mcp/accounts/personal.env', 'CALDAV_PASSWORD=old');
    write(paths.projectRoot, 'model-defaults/local.json', '{"qwen":{}}');
    write(paths.nextRoot, 'model-defaults/examples/qwen.json', 'example');
    await swapProjectTreePreservingData(paths);
    const live = paths.projectRoot;
    // Stack v0.3.14 upgrade step 2: nothing reads these key files any more.
    expect(fs.existsSync(path.join(live, 'compose/twenty/workspaces/main.env'))).toBe(false);
    // Stack v0.3.15: CalDAV accounts moved to the caldav add-on's store; nothing reads these.
    expect(fs.existsSync(path.join(live, 'compose/caldav-mcp/accounts/personal.env'))).toBe(false);
    expect(read(live, 'model-defaults/local.json')).toBe('{"qwen":{}}');
    expect(read(live, 'model-defaults/examples/qwen.json')).toBe('example');
  });

  it('keeps shared-database service logins and the mail and messages index configs', async () => {
    write(paths.projectRoot, 'compose/postgres/services/.gitkeep', '');
    write(paths.projectRoot, 'compose/postgres/services/vikunja.env', 'DB_SERVICE_PASSWORD=keep');
    write(paths.projectRoot, 'mail-index.toml', 'mail config');
    write(paths.projectRoot, 'messages-index.toml', 'messages config');
    write(paths.nextRoot, 'compose/postgres/services/.gitkeep', '');
    write(paths.nextRoot, 'compose/postgres/provision.sh', 'new provision');
    await swapProjectTreePreservingData(paths);
    const live = paths.projectRoot;
    // db-provision turns a role's login off when its env file is gone, and Vikunja then fails
    // its health check, which stops compose before search-gate.
    expect(read(live, 'compose/postgres/services/vikunja.env')).toBe('DB_SERVICE_PASSWORD=keep');
    expect(read(live, 'compose/postgres/services/.gitkeep')).toBe('');
    expect(read(live, 'compose/postgres/provision.sh')).toBe('new provision');
    expect(read(live, 'mail-index.toml')).toBe('mail config');
    expect(read(live, 'messages-index.toml')).toBe('messages config');
  });

  it('replaces the code kept from the previous upgrade', async () => {
    write(paths.previousRoot, 'docker-compose.yml', 'ancient compose');
    await swapProjectTreePreservingData(paths);
    expect(read(paths.previousRoot, 'docker-compose.yml')).toBe('old compose');
  });
});

describe('a swap that fails part-way', () => {
  beforeEach(() => {
    // The new tree has its own files inside carried-over folders, so undoing has to take
    // them out of the user's folders again.
    write(paths.nextRoot, 'data/.gitkeep', '');
    write(paths.nextRoot, 'data/n8n/.gitkeep', '');
    write(paths.nextRoot, 'compose/hermes/worker/ssh/README.md', 'new readme');
  });

  // Reruns the whole swap on the real filesystem once per fs call (over 20), so it takes about a
  // second alone and several under load; the default 5 s timeout made it flaky.
  it('puts the live tree back exactly as it was, whichever step fails', { timeout: 30_000 }, async () => {
    const before = snapshot(paths.projectRoot);
    const nextBefore = snapshot(paths.nextRoot);
    const counting = instrumentFs(null);
    await swapProjectTreePreservingData(paths);
    const total = counting.calls;
    vi.restoreAllMocks();
    expect(total).toBeGreaterThan(20);

    for (let failAt = 1; failAt <= total; failAt += 1) {
      // Reset to the starting layout.
      fs.rmSync(paths.projectRoot, { recursive: true, force: true });
      fs.rmSync(paths.previousRoot, { recursive: true, force: true });
      fs.rmSync(paths.nextRoot, { recursive: true, force: true });
      for (const [rel, body] of Object.entries(before)) {
        if (!rel.endsWith('/')) write(paths.projectRoot, rel, body);
      }
      for (const [rel, body] of Object.entries(nextBefore)) {
        if (!rel.endsWith('/')) write(paths.nextRoot, rel, body);
      }

      instrumentFs(failAt);
      await expect(swapProjectTreePreservingData(paths), `failing call ${failAt}`).rejects.toThrow(
        /simulated/
      );
      vi.restoreAllMocks();

      expect(snapshot(paths.projectRoot), `failing call ${failAt}`).toEqual(before);
      expect(fs.existsSync(paths.previousRoot), `failing call ${failAt}`).toBe(false);
      expect(fs.existsSync(paths.journalPath), `failing call ${failAt}`).toBe(false);
    }
  });

  it('keeps the journal and the new tree when undoing fails, and recovery finishes the swap', async () => {
    let failedEnv = false;
    const realRename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Carrying .env over fails, and so does moving data/ back out of the new tree.
      if (String(to) === path.join(paths.nextRoot, '.env')) {
        failedEnv = true;
        throw new Error('simulated .env failure');
      }
      if (failedEnv && String(from) === path.join(paths.nextRoot, 'data')) {
        throw new Error('simulated undo failure');
      }
      return realRename(from, to);
    });

    await expect(swapProjectTreePreservingData(paths)).rejects.toThrow(
      /simulated .env failure.*couldn’t undo/
    );
    vi.restoreAllMocks();
    expect(fs.existsSync(paths.journalPath)).toBe(true);
    expect(read(paths.nextRoot, 'data/hermes/state.db')).toBe('chats');

    expect(await recoverInterruptedProjectSwap(paths.journalPath)).toBe(true);
    expect(read(paths.projectRoot, 'docker-compose.yml')).toBe('new compose');
    expect(read(paths.projectRoot, 'data/hermes/state.db')).toBe('chats');
    expect(read(paths.projectRoot, 'data/hermes/profiles/default/vault/vault.enc')).toBe('logins');
    expect(read(paths.projectRoot, '.env')).toBe('SECRET=keep');
    expect(read(paths.projectRoot, 'compose/hermes/worker/ssh/id_ed25519')).toBe('WORKER_KEY=keep');
  });
});

describe('recoverInterruptedProjectSwap', () => {
  it('does nothing without a journal', async () => {
    expect(await recoverInterruptedProjectSwap(paths.journalPath)).toBe(false);
    expect(read(paths.projectRoot, 'docker-compose.yml')).toBe('old compose');
  });

  it('finishes a swap that stopped after the old tree was moved aside', async () => {
    fs.writeFileSync(paths.journalPath, JSON.stringify(paths));
    fs.renameSync(paths.projectRoot, paths.previousRoot);
    // Crash part-way: data already carried, .env not yet.
    fs.renameSync(path.join(paths.previousRoot, 'data'), path.join(paths.nextRoot, 'data'));

    expect(await recoverInterruptedProjectSwap(paths.journalPath)).toBe(true);
    expect(read(paths.projectRoot, 'docker-compose.yml')).toBe('new compose');
    expect(read(paths.projectRoot, 'data/hermes/state.db')).toBe('chats');
    expect(read(paths.projectRoot, '.env')).toBe('SECRET=keep');
    expect(fs.existsSync(paths.journalPath)).toBe(false);
  });

  it('puts the old tree back when the new one is gone', async () => {
    fs.writeFileSync(paths.journalPath, JSON.stringify(paths));
    fs.renameSync(paths.projectRoot, paths.previousRoot);
    fs.rmSync(path.join(home, '.staging'), { recursive: true, force: true });

    expect(await recoverInterruptedProjectSwap(paths.journalPath)).toBe(true);
    expect(read(paths.projectRoot, 'docker-compose.yml')).toBe('old compose');
    expect(read(paths.projectRoot, 'data/hermes/state.db')).toBe('chats');
  });

  it('refuses to guess with an unreadable journal', async () => {
    fs.writeFileSync(paths.journalPath, '{not json');
    await expect(recoverInterruptedProjectSwap(paths.journalPath)).rejects.toThrow(
      /upgrade record/
    );
    expect(read(paths.projectRoot, 'data/hermes/state.db')).toBe('chats');
  });

  it('is safe to run twice', async () => {
    fs.writeFileSync(paths.journalPath, JSON.stringify(paths));
    fs.renameSync(paths.projectRoot, paths.previousRoot);
    await completeProjectSwap(paths);
    await completeProjectSwap(paths);
    expect(read(paths.projectRoot, 'data/hermes/state.db')).toBe('chats');
    expect(read(paths.projectRoot, 'docker-compose.yml')).toBe('new compose');
  });
});
