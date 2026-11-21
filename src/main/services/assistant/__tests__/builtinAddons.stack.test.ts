/**
 * Stack contract: n8n and LightRAG as built-in add-ons (CR 0020 R10, stack 0.3.13).
 *
 * Read-only. Runs `addon.sh list --json` and checks that both entries are listed, that `enabled`
 * follows the `.env` flag Boundary reads, and that n8n's `data.volumes` is what Remove deletes.
 * Only those fields leave `readEntries`. Not covered: `enable`, `disable` and `remove` against a
 * running stack, which change containers and data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runAddonScriptPlain } from '../../addons/addonScript';
import { builtinAddonAvailable, readBuiltinEnabled, type BuiltinAddonId } from '../../addons/builtinAddons';
import { probeStack, skipNote } from './stackHarness';
import { isRecord } from '../../../../shared/utils/isRecord';
import { localRunScript } from '../../stackHost/localScript';
import { localStackFiles } from '../../stackHost/localStackHost';

const probe = await probeStack();
const root = probe.ok ? probe.target.root : '';
const rootFiles = localStackFiles({ stackRoot: root, userContentRoot: () => `${root}/data` });
const ready = probe.ok && (await builtinAddonAvailable(rootFiles, 'n8n')) && (await builtinAddonAvailable(rootFiles, 'lightrag'));
const note = probe.ok && !ready ? ' (skipped: the stack tree has no built-in n8n and LightRAG manifests)' : skipNote(probe);

interface Entry {
  enabled: unknown;
  volumes: unknown;
}

async function readEntries(): Promise<Record<BuiltinAddonId, Entry>> {
  const outcome = await runAddonScriptPlain({ runScript: localRunScript(root), env: process.env, script: 'addon.sh', args: ['list', '--json'], timeoutMs: 60_000 });
  if (outcome.code !== 0) throw new Error(`addon.sh list exited with code ${outcome.code}`);
  let list: unknown;
  try {
    list = JSON.parse(outcome.stdout);
  } catch {
    throw new Error('addon.sh list did not print JSON');
  }
  const entry = (id: BuiltinAddonId): Entry => {
    const found = Array.isArray(list) ? list.find((e) => isRecord(e) && e.shortId === id) : undefined;
    if (!isRecord(found)) throw new Error(`addon.sh list has no ${id} entry`);
    const data = isRecord(found.data) ? found.data : {};
    return { enabled: found.enabled, volumes: data.volumes };
  };
  return { n8n: entry('n8n'), lightrag: entry('lightrag') };
}

describe.skipIf(!ready)(`n8n and LightRAG add-ons${note}`, () => {
  let entries: Record<BuiltinAddonId, Entry>;

  beforeAll(async () => {
    entries = await readEntries();
  });

  it('reports each as enabled exactly when its .env flag is on', async () => {
    expect(entries.n8n.enabled).toBe(await readBuiltinEnabled(rootFiles, 'n8n'));
    expect(entries.lightrag.enabled).toBe(await readBuiltinEnabled(rootFiles, 'lightrag'));
  });

  it('names n8n_storage among the volumes n8n’s Remove deletes', () => {
    expect(entries.n8n.volumes).toEqual(expect.arrayContaining(['n8n_storage']));
  });
});
