import { describe, expect, it } from 'vitest';
import { createFakeStackFiles } from '../../stackHost/fakeStackFiles';
import { availableAddons } from '../addonCatalog';

/** Stack files holding `addon.sh` and the given files, keyed by path in the stack folder. */
const tree = (stackFiles: Record<string, unknown>) =>
  createFakeStackFiles(
    Object.fromEntries(
      Object.entries(stackFiles).map(([p, v]) => [`stack:${p}`, typeof v === 'string' ? v : JSON.stringify(v)])
    )
  );

describe('availableAddons', () => {
  it('lists Twenty when the stack has scripts/crm.sh', async () => {
    const entries = await availableAddons(tree({ 'scripts/crm.sh': '' }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: 'twenty',
      name: 'Twenty CRM',
      version: '2.55.0',
      profile: 'crm',
      flags: ['TWENTY_LOCAL_ENABLED', 'TWENTY_MCP_ENABLED'],
      services: ['twenty-server', 'twenty-worker', 'twenty-db', 'twenty-redis'],
      reserveMiB: 2208,
      limitMiB: 2688,
      downloadBytes: 1_120_000_000,
      port: { envKey: 'TWENTY_PORT', default: 3000 },
      restartsHermes: true,
      account: { username: 'owner@crm.localhost' },
    });
  });

  it('lists nothing for a stack without crm.sh', async () => {
    expect(await availableAddons(tree({}))).toEqual([]);
  });

  it('availableAddons offers Email only when the tree has the email manifest', async () => {
    expect((await availableAddons(tree({ 'scripts/addon.sh': '' }))).map((e) => e.id)).toEqual([]);
    const withEmail = await availableAddons(
      tree({
        'scripts/addon.sh': '',
        'addons/email/addon.json': { instances: { name: 'accounts' }, commands: { mailboxes: {} } },
      })
    );
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0]).toMatchObject({
      id: 'email',
      name: 'Email',
      profile: 'email',
      flags: ['EMAIL_ENABLED', 'EMAIL_DRAFTS_ENABLED'],
      services: ['email-mcp', 'email-indexer', 'email-drafts-mcp', 'email-outbox'],
      ownServices: { profile: 'email', services: ['email-mcp', 'email-indexer'] },
      reserveMiB: 384,
      limitMiB: 768,
      downloadBytes: 300_000_000,
      port: null,
      restartsHermes: false,
      account: null,
    });
  });

  it('lists Bitwarden by default only when the tree has its manifest with connect and disconnect', async () => {
    const ids = async (manifest: unknown) =>
      (await availableAddons(tree({ 'scripts/addon.sh': '', 'scripts/vault.sh': '', 'addons/bitwarden/addon.json': manifest }))).map(
        (e) => e.id
      );
    expect(await ids({ instances: {} })).toEqual([]);
    expect(await ids({ instances: { connect: {}, disconnect: {} } })).toEqual(['bitwarden']);
  });

  it('availableAddons offers Todo lists only when the tree has the 0.3.15 manifest', async () => {
    expect(await availableAddons(tree({ 'scripts/addon.sh': '', 'addons/vikunja/addon.json': { hooks: {} } }))).toEqual([]);
    const withTodos = await availableAddons(
      tree({ 'scripts/addon.sh': '', 'addons/vikunja/addon.json': { hooks: { prepare: {} } } })
    );
    expect(withTodos).toHaveLength(1);
    expect(withTodos[0]).toMatchObject({
      id: 'vikunja',
      name: 'Todo lists',
      version: '2.8.0',
      profile: 'todo',
      flags: ['VIKUNJA_MCP_ENABLED'],
      services: ['vikunja', 'vikunja-proxy'],
      reserveMiB: 192,
      limitMiB: 384,
      port: { envKey: 'VIKUNJA_PORT', default: 3456 },
      restartsHermes: false,
      account: null,
    });
  });
});
