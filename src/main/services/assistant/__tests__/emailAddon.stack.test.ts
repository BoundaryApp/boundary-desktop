/**
 * Stack contract: the email add-on's settings (ADR 0031 §1, spec phase 9).
 *
 * Read-only. Runs `addon.sh list --json` and checks the `email` entry's `schema`: the names and
 * types of the settings Boundary sends through `configure`. The listing also holds the user's
 * account values (host, user, address, mailboxes), so only the `schema` object leaves
 * `readSchema`; the instances, the settings values and the whole entry are never passed to
 * `expect`, a log or an error message.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runAddonScriptPlain } from '../../addons/addonScript';
import { emailAvailable } from '../../addons/emailAddon';
import { probeStack, skipNote } from './stackHarness';
import { isRecord } from '../../../../shared/utils/isRecord';
import { localRunScript } from '../../stackHost/localScript';
import { localStackFiles } from '../../stackHost/localStackHost';

const probe = await probeStack();
const root = probe.ok ? probe.target.root : '';
const ready = probe.ok && (await emailAvailable(localStackFiles({ stackRoot: root, userContentRoot: () => `${root}/data` })));
const note = probe.ok && !ready ? ' (skipped: the stack tree does not offer the email add-on)' : skipNote(probe);

type Spec = Record<string, unknown>;
interface EmailSchema {
  settings: Record<string, Spec>;
  instances: { name: unknown; settings: Record<string, Spec> };
}

/** The `email` entry's `schema` and nothing else from the listing. Throws a message with no listing content. */
async function readSchema(): Promise<EmailSchema> {
  const outcome = await runAddonScriptPlain({ runScript: localRunScript(root), env: process.env, script: 'addon.sh', args: ['list', '--json'], timeoutMs: 60_000 });
  if (outcome.code !== 0) throw new Error(`addon.sh list exited with code ${outcome.code}`);
  let list: unknown;
  try {
    list = JSON.parse(outcome.stdout);
  } catch {
    throw new Error('addon.sh list did not print JSON');
  }
  const entry = Array.isArray(list) ? list.find((e) => isRecord(e) && e.shortId === 'email') : undefined;
  if (!isRecord(entry) || !isRecord(entry.schema)) throw new Error('addon.sh list has no email schema');
  const { settings, instances } = entry.schema;
  if (!isRecord(settings) || !isRecord(instances) || !isRecord(instances.settings)) {
    throw new Error('the email schema has no settings or instances');
  }
  return { settings: settings as Record<string, Spec>, instances: { name: instances.name, settings: instances.settings as Record<string, Spec> } };
}

describe.skipIf(!ready)(`Email add-on schema${note}`, () => {
  let schema: EmailSchema;

  beforeAll(async () => {
    schema = await readSchema();
  });

  it('names its instances accounts', () => {
    expect(schema.instances.name).toBe('accounts');
  });

  it('takes the per-account settings configure sends', () => {
    const s = schema.instances.settings;
    for (const name of ['host', 'port', 'security', 'user', 'address', 'mailboxes', 'password']) {
      expect(s, `account setting ${name}`).toHaveProperty(name);
    }
    expect(s.security.options).toEqual(expect.arrayContaining(['tls', 'starttls', 'plain']));
    expect(s.password.type).toBe('secret');
  });

  it('takes the add-on settings configure sends', () => {
    const s = schema.settings;
    expect(s.since?.type).toBe('date');
    expect(s.bodies, 'setting bodies').toBeDefined();
    expect(s.attachments, 'setting attachments').toBeDefined();
    expect(s.drafts?.flag).toBe('EMAIL_DRAFTS_ENABLED');
  });
});
