/**
 * Stack contract: Bitwarden accounts from Boundary (ADR 0031 §1, spec phase 8, CR 0028).
 *
 * The first part runs Boundary's Bitwarden service against the stack's real `addon.sh` and
 * `vault.sh` in a scratch copy of the stack's scripts, with a stub broker: a `docker` on PATH
 * that answers the broker's `ps`, restart and `broker.cli accounts`, as the stack's own
 * `scripts/test-bitwarden-connect.sh` does. It connects a manual account, reads `status --json`,
 * checks a refused key writes nothing, and disconnects. It writes only to a temp folder.
 *
 * The second part needs the running stack with `BITWARDEN_ENABLED=1`: it opens a new chat on the
 * default profile and finds `bitwarden_request_access` among its tools. It changes nothing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isActualFailure } from '../../../../shared/types/addons';
import { runAddonScript, runScriptJson } from '../../addons/addonScript';
import { bitwardenOffered, createBitwardenService, readBitwardenEnabled, type BitwardenService } from '../../addons/bitwardenAddon';
import { ensureBitwardenFolders } from '../../addons/bitwardenFolders';
import { HermesGatewaySession } from '../hermes/hermesGatewaySession';
import { defaultStackRoot, probeStack, skipNote } from './stackHarness';
import { localRunScript } from '../../stackHost/localScript';
import { localStackFiles } from '../../stackHost/localStackHost';

const stackRoot = process.env.BOUNDARY_ASSISTANT_ROOT?.trim() || defaultStackRoot() || '';
const hasTree = Boolean(stackRoot) && (await bitwardenOffered(localStackFiles({ stackRoot, userContentRoot: () => `${stackRoot}/data` })));
const hasPython = spawnSync('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)']).status === 0;
const treeNote = !hasTree
  ? ' (skipped: the stack tree has no Bitwarden accounts as instances, CR 0028)'
  : !hasPython
    ? ' (skipped: needs python3 3.9 or later on the host)'
    : '';

const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB/log"
case " $* " in
  *" ps "*bitwarden-broker*) echo cid-broker; exit 0 ;;
  *" --force-recreate bitwarden-broker"*) exit 0 ;;
  *" broker.cli accounts "*) cat "$STUB/accounts" 2>/dev/null; exit 0 ;;
  *" exec -T bitwarden-broker sh -c "*)
    for a do last="$a"; done
    rm -rf "$STUB_DATA/bw/\${last#/data/bw/}"; exit 0 ;;
esac
exit 0
`;

const CLIENT_ID = `user.synthetic-${process.pid}`;
const SECRET = `synthetic-secret-${process.pid}-Kx4`;

describe.skipIf(!hasTree || !hasPython)(`Bitwarden accounts against a stub broker${treeNote}`, () => {
  let tmp = '';
  let root = '';
  let stub = '';
  let service: BitwardenService;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bitwarden-stack-')));
    root = path.join(tmp, 'stack');
    stub = path.join(tmp, 'stub');
    for (const dir of [path.join(root, 'scripts', 'lib'), path.join(tmp, 'bin'), stub, path.join(tmp, 'hosttmp')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    for (const script of ['addon.sh', 'vault.sh']) fs.copyFileSync(path.join(stackRoot, 'scripts', script), path.join(root, 'scripts', script));
    // All of scripts/lib, not a list of files: the two scripts source more of it with each
    // stack version (v0.3.16's addon.sh added stack-lock.sh).
    fs.cpSync(path.join(stackRoot, 'scripts', 'lib'), path.join(root, 'scripts', 'lib'), { recursive: true });
    fs.cpSync(path.join(stackRoot, 'addons'), path.join(root, 'addons'), { recursive: true });
    fs.copyFileSync(path.join(stackRoot, 'docker-compose.yml'), path.join(root, 'docker-compose.yml'));
    fs.writeFileSync(path.join(root, '.env'), 'COMPOSE_PROJECT_NAME=bwboundary\nBITWARDEN_ENABLED=1\n');
    fs.writeFileSync(path.join(tmp, 'bin', 'docker'), DOCKER_STUB, { mode: 0o755 });

    const env: NodeJS.ProcessEnv = {
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      TMPDIR: path.join(tmp, 'hosttmp'),
      STACK_PYTHON: 'host',
      STUB: stub,
      STUB_DATA: path.join(root, 'data', 'addons', 'bitwarden'),
      VAULT_BROKER_WAIT: '0',
    };
    service = createBitwardenService({
      files: localStackFiles({ stackRoot: root, userContentRoot: () => path.join(root, 'data') }),
      run: (script, args, options = {}) => runAddonScript({ runScript: localRunScript(root), env, script, args, timeoutMs: 120_000, ...options }),
      runJson: (script, args) => runScriptJson({ runScript: localRunScript(root), env, script, args, timeoutMs: 60_000 }),
      exclusive: (work) => work(),
      ensureFolders: () => ensureBitwardenFolders({ root, dataRoot: path.join(root, 'data') }, { ...process.env, BITWARDEN_HOST_DATA_DIR: '' }),
      log: () => undefined,
    });
  });

  afterAll(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const input = {
    slug: 'home',
    server: { kind: 'us' as const },
    scope: 'folder:Agent',
    unlock: 'manual' as const,
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    replace: false,
  };
  // From stack v0.3.14 vault.sh keeps an account's key in secrets/<slug>/ under the add-on's
  // data folder, where the broker reads it, not in compose/bitwarden/accounts/<slug>.env.
  const secretsDir = () => path.join(root, 'data', 'addons', 'bitwarden', 'secrets', 'home');
  const storeEntry = () => path.join(root, 'data', 'addons', 'bitwarden', 'instances', 'home.json');

  it('a refused API key ends with login_refused and leaves nothing behind', { timeout: 120_000 }, async () => {
    fs.writeFileSync(path.join(stub, 'accounts'), 'home\tcloud\tfolder\terror\tauth\t0\t\n');
    expect(await service.connect(input)).toMatchObject({ ok: false, error: 'login_refused' });
    expect(fs.existsSync(secretsDir())).toBe(false);
    expect(fs.existsSync(storeEntry())).toBe(false);
  });

  it('connects a manual account with the key on stdin only, and status reads it locked', { timeout: 120_000 }, async () => {
    fs.writeFileSync(path.join(stub, 'accounts'), 'home\tcloud\tfolder\tlocked\t-\t1\t\n');
    const result = await service.connect(input);
    if (isActualFailure(result)) throw new Error(`connect: ${result.error}: ${result.message}`);
    expect(result.message).toContain('home');
    // The key reached the secrets folder through stdin, readable by its owner only.
    const secretFile = path.join(secretsDir(), 'client_secret');
    expect(fs.readFileSync(secretFile, 'utf8').trim()).toBe(SECRET);
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    // The store entry holds the settings without the transient secrets.
    const entry = fs.readFileSync(storeEntry(), 'utf8');
    expect(entry).not.toContain(SECRET);
    expect(entry).not.toContain(CLIENT_ID);
    // No docker argv carried the key.
    const log = fs.readFileSync(path.join(stub, 'log'), 'utf8');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(CLIENT_ID);

    const overview = await service.refresh();
    expect(overview.accounts).toEqual([
      expect.objectContaining({ slug: 'home', mode: 'cloud', scope: 'folder:Agent', unlock: 'manual', state: 'locked', error: null, canDisconnect: true }),
    ]);
  });

  it('disconnects it and passes on the reminder to revoke the key', { timeout: 120_000 }, async () => {
    const result = await service.disconnect('home');
    if (isActualFailure(result)) throw new Error(`disconnect: ${result.error}: ${result.message}`);
    expect(result.message).toMatch(/revoke/i);
    expect(fs.existsSync(secretsDir())).toBe(false);
    expect(fs.existsSync(storeEntry())).toBe(false);
  });
});

const probe = await probeStack();
const liveRoot = probe.ok ? probe.target.root : '';
const liveFiles = localStackFiles({ stackRoot: liveRoot, userContentRoot: () => `${liveRoot}/data` });
const liveOn = probe.ok && (await bitwardenOffered(liveFiles)) && (await readBitwardenEnabled(liveFiles));

describe.skipIf(!probe.ok)(`Bitwarden tools in a new chat${skipNote(probe)}`, () => {
  const session = new HermesGatewaySession();

  afterAll(() => session.dispose());

  it.skipIf(!liveOn)(
    `a new chat on the default profile lists bitwarden_request_access${liveOn ? '' : ' (skipped: BITWARDEN_ENABLED isn’t 1 in the stack under test)'}`,
    { timeout: 120_000 },
    async () => {
      const client = await session.ensureConnected();
      const created = (await client.request('session.create', { close_on_disconnect: true })) as { session_id: string };
      try {
        const shown = (await client.request('tools.show', { session_id: created.session_id })) as {
          sections?: Array<{ tools?: Array<{ name?: string }> }>;
        };
        const names = (shown.sections ?? []).flatMap((s) => (s.tools ?? []).map((t) => t.name));
        expect(names).toContain('bitwarden_request_access');
      } finally {
        await client.request('session.close', { session_id: created.session_id }).catch((): undefined => undefined);
      }
    }
  );
});
