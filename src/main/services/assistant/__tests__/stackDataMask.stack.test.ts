/**
 * Stack contract: the empty read-only folder Boundary mounts over another stack checkout's
 * `data/` (CR 0040 stack reply, ADR 0028 §6) hides it from the agent's tools on the real
 * terminal service. Runs only under `bun run test:stack`.
 *
 * Builds two synthetic checkouts in temp folders (a `docker-compose.yml` and a dummy
 * `data/hermes/state.db`): one inside a coding grant, one two levels inside a context root.
 * `writeHermesProjectsOverlay` writes the overlay into the test's own stack home, then a
 * throwaway container runs on the live `hermes-worker`'s image as the hermes user, with that
 * container's mounts (`--volumes-from`) plus the overlay's `hermes-worker` lines. The live
 * containers are never recreated. The same runs against `opencode` when it is running.
 *
 * Compose merging the overlay into each service is covered by the unit tests on
 * `buildHermesProjectsOverlayYaml`; this case covers what the mounts do in the container.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeHermesProjectsOverlay } from '../hermes/hermesProjectsOverlay';
import { probeStack, skipNote, type StackTarget } from './stackHarness';

const run = promisify(execFile);
const probe = await probeStack();

async function serviceContainer(target: StackTarget, service: string): Promise<string | null> {
  const { stdout } = await run(target.docker, [
    'ps',
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--filter',
    `label=com.docker.compose.project.working_dir=${target.root}`,
    '--format',
    '{{.Names}}',
  ]);
  return stdout.split('\n').map((line) => line.trim()).find(Boolean) ?? null;
}

/** Image and user of a running container; the user is the hermes ids when the container sets them. */
async function containerFacts(
  target: StackTarget,
  container: string
): Promise<{ image: string; user: string }> {
  const { stdout } = await run(target.docker, [
    'inspect',
    '-f',
    '{{json .Config.Image}} {{json .Config.User}} {{json .Config.Env}}',
    container,
  ]);
  const [image, user, env] = stdout.trim().split(' ').map((part) => JSON.parse(part)) as [
    string,
    string,
    string[] | null,
  ];
  const vars = new Map((env ?? []).map((line) => [line.split('=')[0], line.split('=')[1]]));
  const uid = vars.get('HERMES_UID');
  const gid = vars.get('HERMES_GID');
  return { image, user: uid && gid ? `${uid}:${gid}` : user };
}

/** One `key=value` line per check, read back as a map. */
const SCRIPT = `
for d in "$GRANT/stack-copy/data" "$CTX/nested/stack/data"; do
  if [ -d "$d" ]; then echo "dir:$d=yes"; else echo "dir:$d=no"; fi
  echo "entries:$d=$(ls -A "$d" 2>/dev/null | wc -l | tr -d ' ')"
  if touch "$d/probe" 2>/dev/null; then echo "write:$d=ok"; else echo "write:$d=denied"; fi
done
echo "read:grant=$(cat "$GRANT/notes.txt" 2>/dev/null)"
echo "read:checkout=$(cat "$GRANT/stack-copy/README.md" 2>/dev/null)"
echo "read:ctx=$(cat "$CTX/nested/stack/README.md" 2>/dev/null)"
if echo from-container > "$GRANT/written.txt" 2>/dev/null; then echo "write:grant=ok"; else echo "write:grant=denied"; fi
if touch "$CTX/probe" 2>/dev/null; then echo "write:ctx=ok"; else echo "write:ctx=denied"; fi
`;

function fakeCheckout(dir: string, note: string): void {
  fs.mkdirSync(path.join(dir, 'data', 'hermes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, 'data', 'hermes', 'state.db'), 'synthetic, not a database\n');
  fs.writeFileSync(path.join(dir, 'README.md'), note);
}

describe.skipIf(!probe.ok)(`stack checkout data mask${skipNote(probe)}`, () => {
  let grant: string;
  let ctxRoot: string;
  let overlay: Record<string, { volumes?: string[] }>;

  beforeAll(async () => {
    // realpath: on macOS os.tmpdir() sits behind the /var symlink, and binds use the real path.
    grant = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-mask-grant-')));
    ctxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-mask-ctx-')));
    fs.writeFileSync(path.join(grant, 'notes.txt'), 'grant sibling');
    fakeCheckout(path.join(grant, 'stack-copy'), 'checkout sibling');
    fakeCheckout(path.join(ctxRoot, 'nested', 'stack'), 'context sibling');

    const overlayPath = await writeHermesProjectsOverlay([], [ctxRoot], {
      roots: [grant],
      shadows: [],
      shadowSource: '',
    });
    overlay = (load(fs.readFileSync(overlayPath, 'utf8')) as {
      services: Record<string, { volumes?: string[] }>;
    }).services;
  });

  afterAll(() => {
    // Docker Desktop can hold the masked mount points for a moment after `run --rm` exits, so
    // the first removal can see ENOTEMPTY; rmSync retries that error.
    for (const dir of [grant, ctxRoot]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  async function runChecks(service: 'hermes-worker' | 'opencode', withCtx: boolean) {
    if (!probe.ok) throw new Error('unreachable');
    const container = await serviceContainer(probe.target, service);
    if (!container) return null;
    const { image, user } = await containerFacts(probe.target, container);
    const volumes = overlay[service]?.volumes ?? [];
    const { stdout } = await run(
      probe.target.docker,
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volumes-from',
        container,
        ...(user ? ['--user', user] : []),
        ...volumes.flatMap((line) => ['-v', line]),
        '-e',
        `GRANT=${grant}`,
        '-e',
        `CTX=${withCtx ? ctxRoot : '/nonexistent'}`,
        '--entrypoint',
        'sh',
        image,
        '-c',
        SCRIPT,
      ],
      { timeout: 60_000 }
    );
    return Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
  }

  it('the overlay masks both checkouts on hermes-worker and the grant on opencode', () => {
    const mask = (dir: string) => expect.stringMatching(new RegExp(`:${dir}/data:ro$`));
    const worker = overlay['hermes-worker']?.volumes ?? [];
    expect(worker).toEqual(expect.arrayContaining([mask(path.join(grant, 'stack-copy'))]));
    expect(worker).toEqual(expect.arrayContaining([mask(path.join(ctxRoot, 'nested', 'stack'))]));
    expect(overlay.opencode?.volumes ?? []).toEqual(
      expect.arrayContaining([mask(path.join(grant, 'stack-copy'))])
    );
  });

  it('hermes-worker sees an empty, unwritable data/ and the rest of each folder', async () => {
    const result = await runChecks('hermes-worker', true);
    expect(result).not.toBeNull();
    const grantData = path.join(grant, 'stack-copy', 'data');
    const ctxData = path.join(ctxRoot, 'nested', 'stack', 'data');
    expect(result).toEqual({
      [`dir:${grantData}`]: 'yes',
      [`entries:${grantData}`]: '0',
      [`write:${grantData}`]: 'denied',
      [`dir:${ctxData}`]: 'yes',
      [`entries:${ctxData}`]: '0',
      [`write:${ctxData}`]: 'denied',
      'read:grant': 'grant sibling',
      'read:checkout': 'checkout sibling',
      'read:ctx': 'context sibling',
      'write:grant': 'ok',
      'write:ctx': 'denied',
    });
    expect(fs.readFileSync(path.join(grant, 'written.txt'), 'utf8')).toBe('from-container\n');
    for (const data of [grantData, ctxData]) {
      expect(fs.readdirSync(data)).toEqual(['hermes']);
      expect(fs.readFileSync(path.join(data, 'hermes', 'state.db'), 'utf8')).toBe(
        'synthetic, not a database\n'
      );
    }
  });

  it('opencode sees an empty, unwritable data/ under the grant', async (ctx) => {
    const result = await runChecks('opencode', false);
    if (!result) {
      ctx.skip('no running opencode container (coding profile off)');
      return;
    }
    const grantData = path.join(grant, 'stack-copy', 'data');
    expect(result).toMatchObject({
      [`dir:${grantData}`]: 'yes',
      [`entries:${grantData}`]: '0',
      [`write:${grantData}`]: 'denied',
      'read:grant': 'grant sibling',
      'read:checkout': 'checkout sibling',
      'write:grant': 'ok',
    });
    expect(fs.readdirSync(grantData)).toEqual(['hermes']);
  });
});
