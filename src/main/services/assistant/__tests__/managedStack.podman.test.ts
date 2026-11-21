/**
 * Podman check (`bun run test:podman`): starts the managed agent stack on Boundary's bundled
 * Podman through ensureAssistantStackRunning, the path the app takes on a Mac without Docker
 * Desktop, and fails when Hermes's health check or any container does.
 *
 * Opt in with BOUNDARY_PODMAN_CHECK=1; the file skips otherwise. macOS only, with the bundled
 * engine fetched (`./scripts/fetch-container-runtime.sh`).
 *
 *   BOUNDARY_PODMAN_CHECK_DIR      userData folder for the run (default: a new folder under
 *                                  $TMPDIR/boundary-podman-check, which vitest.podman.config.ts
 *                                  sets as the run's TMPDIR). The pinned stack, its data and its
 *                                  .env go here. The debug log is in that same parent folder.
 *   BOUNDARY_PODMAN_CHECK_KEEP=1   leave the stack running and the folder in place afterwards.
 *   BOUNDARY_PODMAN_CHECK_REPLACE=1  remove a `boundary-assistant` project already on the
 *                                  machine first (its named volumes go too; bind mounts stay).
 *   BOUNDARY_PODMAN_CHECK_BITWARDEN=1  after the stack is healthy, Get Bitwarden as the add-on
 *                                  store does (`addon.sh enable bitwarden`), and fail unless
 *                                  bitwarden-broker and bitwarden-signin are running and the
 *                                  signer's /health reports ready or busy, not sandbox_unavailable.
 *                                  It first makes a signer volume with the stack's own options, as
 *                                  an install from before the Podman overlay has, and checks that
 *                                  Get Bitwarden replaces it. Then it runs CR 0041 R1's acceptance
 *                                  (sync.sock at 600, broker.unlock over the socket), stops and
 *                                  starts both services, and checks signin.sock again and the
 *                                  signer in `vault.sh status --json`, printing each output.
 *
 * The `boundary` Podman machine is shared with the app, so the check refuses to run while that
 * machine holds a `boundary-assistant` project, unless told to replace it. It stops the machine
 * afterwards if this run started it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const enabled = process.env.BOUNDARY_PODMAN_CHECK === '1' && process.platform === 'darwin';
const keep = process.env.BOUNDARY_PODMAN_CHECK_KEEP === '1';
const replace = process.env.BOUNDARY_PODMAN_CHECK_REPLACE === '1';
const bitwarden = process.env.BOUNDARY_PODMAN_CHECK_BITWARDEN === '1';
const givenUserData = process.env.BOUNDARY_PODMAN_CHECK_DIR?.trim();
const madeUserData = enabled && !givenUserData;
// Read by the electron mock below, which runs on the first import of electron, after this.
const userData = givenUserData
  ? path.resolve(givenUserData)
  : madeUserData
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-podman-check-'))
    : path.join(os.tmpdir(), 'boundary-podman-check-unused');

// Replaces the setup file's electron mock: userData is this run's folder, and the app path
// sits two levels under the repository, as in `electron-forge start`, so the bundled engine
// resolves from resources/container-runtime.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'userData' ? userData : path.join(userData, 'electron-paths', name),
    getAppPath: () => path.join(process.cwd(), '.vite', 'build'),
    getVersion: () => '0.0.0-podman-check',
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: (): Electron.BrowserWindow[] => [] },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value, 'utf-8'),
    decryptStringAsync: async (buf: Buffer) => ({ result: buf.toString('utf-8'), shouldReEncrypt: false }),
  },
}));

/** The containers Get Bitwarden starts (stack v0.3.16). */
const BITWARDEN_SERVICES = ['bitwarden-broker', 'bitwarden-signin'] as const;

/**
 * Prints the signer's `/health` status, asked over its socket the way the stack's healthcheck asks
 * (stack v0.3.16 docker-compose.yml). The signer binds the socket only after its sandbox probe.
 */
const SIGNER_HEALTH_PY = [
  'import http.client, json, socket',
  "c = http.client.HTTPConnection('localhost', timeout=3)",
  'c.sock = socket.socket(socket.AF_UNIX)',
  'c.sock.settimeout(3)',
  "c.sock.connect('/run/bitwarden-signin/signin.sock')",
  "c.request('GET', '/health')",
  "print(json.load(c.getresponse()).get('status'))",
].join('\n');

/** One row of `compose ps --format json`. */
interface ComposePsRow {
  Name: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

/** Services of `wanted` that aren't running, as `service: state` (or `missing`). */
function notRunning(rows: ComposePsRow[], wanted: readonly string[]): string[] {
  return wanted.flatMap((service) => {
    const row = rows.find((r) => r.Service === service);
    if (!row) return [`${service}: missing`];
    return row.State === 'running' ? [] : [`${service}: ${row.State}`];
  });
}

/** Compose prints one JSON array (older releases) or one object per line (2.21 and later). */
function parseComposePs(stdout: string): ComposePsRow[] {
  const text = stdout.trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text) as ComposePsRow[];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ComposePsRow);
}

/**
 * Containers that failed: exited with a non-zero code, unhealthy, or stuck restarting. A
 * bootstrap that exited 0 has done its job.
 */
function failedContainers(rows: ComposePsRow[]): string[] {
  return rows
    .filter(
      (row) =>
        (row.State === 'exited' && row.ExitCode !== 0) ||
        row.State === 'restarting' ||
        row.State === 'dead' ||
        row.Health === 'unhealthy'
    )
    .map((row) => `${row.Service} (${row.Name}): ${row.State}${row.Health ? `, ${row.Health}` : ''}, exit ${row.ExitCode}`);
}

describe.skipIf(!enabled)('managed agent stack on bundled Podman', () => {
  type Runtime = Awaited<ReturnType<typeof import('../../containerRuntime').getContainerRuntime>>;
  let runtime: Runtime;
  let project: string;
  let passed = false;
  /** Set once the check has made sure no other project is there, so cleanup is this run's. */
  let ownsProject = false;

  beforeAll(async () => {
    // The managed install, never a local checkout or a live developer stack.
    delete process.env.BOUNDARY_ASSISTANT_ROOT;
    delete process.env.BOUNDARY_LOCAL_STACK;
    // Skip Docker Desktop, as on a Mac without it.
    process.env.BOUNDARY_EMULATE_NO_DOCKER = '1';
    console.log(`podman check: userData ${userData}`);

    const { resolveBundledRuntimePaths, getContainerRuntime, runCli } = await import('../../containerRuntime');
    const { BOUNDARY_ASSISTANT_PROJECT_NAME } = await import('../../../../shared/assistantStackConstants');
    project = BOUNDARY_ASSISTANT_PROJECT_NAME;

    const podmanPath = resolveBundledRuntimePaths().podmanPath;
    if (!fs.existsSync(podmanPath)) {
      throw new Error(`No bundled Podman at ${podmanPath}. Run ./scripts/fetch-container-runtime.sh first.`);
    }

    runtime = await getContainerRuntime();
    expect(runtime.kind).toBe('podman');
    expect(runtime.origin).toBe('bundled');

    const existing = (
      await runCli(runtime, ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`])
    ).stdout.trim();
    if (existing && !replace) {
      throw new Error(
        `The bundled Podman machine already has a ${project} project, which this check would replace. ` +
          'Remove it, or set BOUNDARY_PODMAN_CHECK_REPLACE=1 to have the check remove it.'
      );
    }
    ownsProject = true;
    if (existing) await composeDown();
  });

  async function composeDown(): Promise<void> {
    const { runCompose } = await import('../../containerRuntime');
    // No compose files: down finds the project's containers, networks and volumes by label.
    await runCompose(runtime, ['-p', project, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], {
      timeout: 5 * 60_000,
    });
  }

  afterAll(async () => {
    if (!runtime) {
      // Stopped before the engine was resolved: nothing ran, so the folder is empty.
      if (madeUserData) fs.rmSync(userData, { recursive: true, force: true });
      return;
    }
    const { stopBundledMachineIfStarted } = await import('../../containerRuntime');
    if (!ownsProject) {
      // Refused because the machine holds a project that isn't this run's: leave it alone.
      await stopBundledMachineIfStarted();
      if (madeUserData) fs.rmSync(userData, { recursive: true, force: true });
      return;
    }
    if (keep) {
      console.log(`podman check: left ${project} running; userData ${userData}`);
      return;
    }
    try {
      await composeDown();
    } finally {
      await stopBundledMachineIfStarted();
      if (madeUserData && passed) fs.rmSync(userData, { recursive: true, force: true });
      else console.log(`podman check: kept userData ${userData}`);
    }
  });

  it('starts, passes the Hermes health check, and leaves no failed container', async () => {
    const { ensureAssistantStackRunning, isAssistantStackReady, getAssistantStackStatus } = await import(
      '../AssistantStackService'
    );
    const { runCompose } = await import('../../containerRuntime');
    const { getDebugLogPath } = await import('../../../persistDebugLog');
    console.log(`podman check: debug log ${getDebugLogPath()}`);

    const result = await ensureAssistantStackRunning();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(await isAssistantStackReady()).toBe(true);
    console.log(`podman check: Hermes healthy at ${(await getAssistantStackStatus()).healthUrl}`);

    const ps = await runCompose(runtime, ['-p', project, 'ps', '-a', '--format', 'json'], { timeout: 60_000 });
    const rows = parseComposePs(ps.stdout);
    expect(rows.length).toBeGreaterThan(0);
    expect(failedContainers(rows)).toEqual([]);
    passed = !bitwarden;
  });

  it.skipIf(!bitwarden)('gets Bitwarden, and bitwarden-broker and bitwarden-signin run', async () => {
    const { getAddonInstaller } = await import('../../addons/addonInstaller');
    const { runCompose } = await import('../../containerRuntime');
    const { runCli } = await import('../../containerRuntime');
    const installer = getAddonInstaller();
    // A signer volume as an install from before CR 0042's overlay made it, with the stack's own
    // options. Get Bitwarden has to remove it, or compose keeps it and the signer exits 2.
    const signerVolume = `${project}_bitwarden_signin`;
    await runCli(
      runtime,
      [
        'volume', 'create', '--driver', 'local',
        '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=uid=1000,gid=1000,mode=0700,size=1m',
        '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.volume=bitwarden_signin',
        signerVolume,
      ],
      { timeout: 30_000 }
    );
    // The first enable builds both images on the machine.
    await installer.install('bitwarden');
    const snapshot = installer.snapshot();
    if (snapshot?.error) {
      console.log(`podman check: Bitwarden ${snapshot.error.step} failed:\n${snapshot.error.logTail.join('\n')}`);
      // The signer's own startup lines: config and socket errors, the sandbox probe. It logs no
      // session content before a session starts.
      const logs = await runCli(runtime, ['logs', '--tail', '20', 'boundary-bitwarden-signin'], { timeout: 30_000 }).catch(
        (error: Error) => ({ stdout: '', stderr: error.message })
      );
      console.log(`podman check: bitwarden-signin log:\n${logs.stdout}${logs.stderr}`);
      const volume = await runCli(
        runtime,
        ['volume', 'inspect', signerVolume, '--format', '{{json .Options}} uid={{.UID}} gid={{.GID}}'],
        { timeout: 30_000 }
      ).catch((error: Error) => ({ stdout: '', stderr: error.message }));
      console.log(`podman check: bitwarden_signin volume: ${volume.stdout}${volume.stderr}`);
      const enginePath = path.join(userData, 'assistant-stack', 'docker-compose.engine.yml');
      console.log(`podman check: engine overlay:\n${fs.existsSync(enginePath) ? fs.readFileSync(enginePath, 'utf8') : '(none)'}`);
    }
    expect(snapshot?.error?.message).toBeUndefined();
    expect(snapshot?.done).toBe(true);

    const ps = await runCompose(runtime, ['-p', project, 'ps', '-a', '--format', 'json'], { timeout: 60_000 });
    const rows = parseComposePs(ps.stdout);
    expect(notRunning(rows, BITWARDEN_SERVICES)).toEqual([]);
    expect(failedContainers(rows)).toEqual([]);
    console.log('podman check: bitwarden-broker and bitwarden-signin running');

    const made = await runCli(runtime, ['volume', 'inspect', signerVolume, '--format', '{{index .Options "o"}}'], {
      timeout: 30_000,
    });
    expect(made.stdout.trim()).toContain('context=system_u:object_r:container_file_t:s0');
    console.log('podman check: stale bitwarden_signin volume replaced');

    // Chromium's sandbox needs Podman's default profile plus CAP_SYS_CHROOT (CR 0042); without it
    // the signer runs but reports sandbox_unavailable and refuses sign-in sessions.
    const signer = rows.find((row) => row.Service === 'bitwarden-signin')!.Name;
    let status = '';
    for (let attempt = 0; attempt < 30 && !status; attempt += 1) {
      try {
        const health = await runCli(runtime, ['exec', signer, '/opt/hermes/.venv/bin/python', '-c', SIGNER_HEALTH_PY], {
          timeout: 30_000,
        });
        status = health.stdout.trim();
      } catch {
        // Not listening yet: the probe starts Chromium first.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    console.log(`podman check: bitwarden-signin /health status ${status || '(no answer)'}`);
    expect(['ready', 'busy']).toContain(status);
    passed = true;
  });

  // CR 0041: R1's acceptance on Podman (sync.sock at 600, owned by the broker's user, reachable
  // with broker.unlock), then whether the signer gets its socket back after both containers stop
  // and start, on the bitwarden_signin volume as Boundary's Podman overlay defines it (CR 0042 R2:
  // mode=1777, no uid=/gid=, so the folder is root's and only the socket is the signer's).
  it.skipIf(!bitwarden)('keeps the Bitwarden sockets usable across a stop and start', async () => {
    passed = false;
    const { composeOnStack, runJsonOnStack } = await import('../../addons/stackScripts');
    const compose = (args: string[]) =>
      composeOnStack(args, { profiles: ['bitwarden'], timeoutMs: 5 * 60_000 });
    // sh -c with the exit code echoed, so a failing command still prints rather than rejecting.
    const execIn = async (service: string, script: string): Promise<string> => {
      const out = (await compose(['exec', '-T', service, 'sh', '-c', `${script}; echo "exit=$?"`])).trim();
      console.log(`podman check: ${service}$ ${script}\n${out}`);
      return out;
    };
    // Owners compared by uid: HERMES_UID may have no name in the image, where %U prints UNKNOWN.
    const signinStat = 'stat -c "%a %u %U %n" /run/bitwarden-signin /run/bitwarden-signin/signin.sock';

    // 1. R1 acceptance. --lock on a slug that can't exist: exit 3 means the broker answered over
    // the socket, exit 1 that it couldn't be reached.
    const brokerUid = (await execIn('bitwarden-broker', 'id -u')).split('\n')[0];
    const syncStat = await execIn('bitwarden-broker', 'stat -c "%a %u %U %n" /run/bitwarden-sync /run/bitwarden-sync/sync.sock');
    expect(syncStat).toMatch(new RegExp(`^600 ${brokerUid} \\S+ /run/bitwarden-sync/sync\\.sock$`, 'm'));
    const unlock = await execIn('bitwarden-broker', 'python3 -m broker.unlock --lock boundary-podman-check-none');
    expect(unlock).toContain('exit=3');

    // 2. The signer's socket on first start.
    const signerUid = (await execIn('bitwarden-signin', 'id -u')).split('\n')[0];
    const socketOk = (stat: string) =>
      new RegExp(`^600 ${signerUid} \\S+ /run/bitwarden-signin/signin\\.sock$`, 'm').test(stat);
    const firstStat = await execIn('bitwarden-signin', signinStat);
    expect(socketOk(firstStat)).toBe(true);

    // 3. Stop both, so the tmpfs is unmounted, then start both again.
    console.log(`podman check: ${await compose(['stop', 'bitwarden-broker', 'bitwarden-signin'])}`);
    console.log(`podman check: ${await compose(['up', '-d', '--no-deps', 'bitwarden-signin', 'bitwarden-broker'])}`);
    // The signer creates its socket after start; give it up to a minute.
    let secondStat = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      secondStat = await execIn('bitwarden-signin', signinStat);
      if (secondStat.includes('signin.sock') && secondStat.includes('exit=0')) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(socketOk(secondStat)).toBe(true);

    // 4. The signer's state as vault.sh reports it.
    const status = await runJsonOnStack('vault.sh', ['status', '--json'], { timeoutMs: 2 * 60_000 });
    console.log(`podman check: vault.sh status --json exit ${status.code}\n${status.objects.map((o) => JSON.stringify(o)).join('\n')}`);
    const signer = status.objects.find((line) => 'signer' in line && !('state' in line));
    expect(signer?.signer).toBeDefined();
    expect(signer?.signer).not.toBe('down');
    passed = true;
  });
});

describe('compose ps helpers', () => {
  const row = (over: Partial<ComposePsRow>): ComposePsRow => ({
    Name: 'boundary-hermes',
    Service: 'hermes',
    State: 'running',
    Health: '',
    ExitCode: 0,
    ...over,
  });

  it('reads both the array and the line-per-container formats', () => {
    const rows = [row({}), row({ Service: 'searxng', Name: 'boundary-searxng' })];
    expect(parseComposePs(JSON.stringify(rows))).toEqual(rows);
    expect(parseComposePs(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')).toEqual(rows);
    expect(parseComposePs('  \n')).toEqual([]);
  });

  it('flags non-zero exits, unhealthy and restarting containers, not finished bootstraps', () => {
    const failed = failedContainers([
      row({}),
      row({ Service: 'hermes-api-bootstrap', State: 'exited', ExitCode: 0 }),
      row({ Service: 'n8n', State: 'exited', ExitCode: 1 }),
      row({ Service: 'lightrag', Health: 'unhealthy' }),
      row({ Service: 'neo4j', State: 'restarting' }),
    ]);
    expect(failed.map((line) => line.split(' ')[0])).toEqual(['n8n', 'lightrag', 'neo4j']);
  });

  it('names wanted services that are missing or not running', () => {
    const rows = [row({ Service: 'bitwarden-broker' }), row({ Service: 'bitwarden-signin', State: 'created' })];
    expect(notRunning(rows, BITWARDEN_SERVICES)).toEqual(['bitwarden-signin: created']);
    expect(notRunning([], BITWARDEN_SERVICES)).toEqual(['bitwarden-broker: missing', 'bitwarden-signin: missing']);
  });
});
