/**
 * Stack contract: the Todo lists add-on (CR 0032, stack 0.3.15).
 *
 * Read-only. Runs `addon.sh list --json` and checks the `vikunja` entry's `hooks`, `web` and
 * `data.schemas`, which Get, Open and Remove rely on. Only those fields and `enabled` leave
 * `readEntry`. It also checks that any `web.url` is a loopback URL Boundary would open, without
 * fetching it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runAddonScriptPlain } from '../../addons/addonScript';
import { loopbackWebUrl, vikunjaAvailable } from '../../addons/vikunjaAddon';
import { probeStack, skipNote } from './stackHarness';
import { isRecord } from '../../../../shared/utils/isRecord';
import { localRunScript } from '../../stackHost/localScript';
import { localStackFiles } from '../../stackHost/localStackHost';

const probe = await probeStack();
const root = probe.ok ? probe.target.root : '';
const ready = probe.ok && (await vikunjaAvailable(localStackFiles({ stackRoot: root, userContentRoot: () => `${root}/data` })));
const note = probe.ok && !ready ? ' (skipped: the stack tree does not offer Todo lists)' : skipNote(probe);

interface Entry {
  enabled: unknown;
  hooks: unknown;
  web: Record<string, unknown> | null;
  schemas: unknown;
}

async function readEntry(): Promise<Entry> {
  const outcome = await runAddonScriptPlain({ runScript: localRunScript(root), env: process.env, script: 'addon.sh', args: ['list', '--json'], timeoutMs: 60_000 });
  if (outcome.code !== 0) throw new Error(`addon.sh list exited with code ${outcome.code}`);
  let list: unknown;
  try {
    list = JSON.parse(outcome.stdout);
  } catch {
    throw new Error('addon.sh list did not print JSON');
  }
  const entry = Array.isArray(list) ? list.find((e) => isRecord(e) && e.shortId === 'vikunja') : undefined;
  if (!isRecord(entry)) throw new Error('addon.sh list has no vikunja entry');
  const data = isRecord(entry.data) ? entry.data : {};
  return { enabled: entry.enabled, hooks: entry.hooks, web: isRecord(entry.web) ? entry.web : null, schemas: data.schemas };
}

describe.skipIf(!ready)(`Todo lists add-on${note}`, () => {
  let entry: Entry;

  beforeAll(async () => {
    entry = await readEntry();
  });

  it('runs prepare and init on enable', () => {
    expect(entry.hooks).toEqual(expect.arrayContaining(['prepare', 'init']));
  });

  it('names the signed-in page and the schema Remove drops', () => {
    expect(entry.web).toMatchObject({ service: 'proxy', path: '/login-local' });
    expect(entry.schemas).toEqual(['vikunja']);
  });

  // web_view sets url from compose's published port whether or not the add-on is on (the
  // manifest's services have no gate), so Boundary checks `enabled` itself.
  it('gives a loopback URL when compose publishes the port', () => {
    if (typeof entry.web?.url === 'string') expect(loopbackWebUrl(entry.web.url)).not.toBeNull();
  });
});
