import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { availableAddons } from '../addonCatalog';

describe('availableAddons', () => {
  it('lists Twenty when the stack has scripts/crm.sh', () => {
    const root = '/stack';
    const entries = availableAddons(root, (p) => p === path.join(root, 'scripts', 'crm.sh'));
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

  it('lists nothing for a stack without crm.sh', () => {
    expect(availableAddons('/stack', () => false)).toEqual([]);
  });

  it('availableAddons offers Email only when the tree has the email manifest', () => {
    const none = () => false;
    expect(availableAddons('/stack', none, none, none, none).map((e) => e.id)).toEqual([]);
    const withEmail = availableAddons('/stack', none, none, none, () => true);
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

  it('lists Bitwarden by default only when the tree has its manifest with connect and disconnect', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-bitwarden-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'));
      fs.mkdirSync(path.join(root, 'addons', 'bitwarden'), { recursive: true });
      fs.writeFileSync(path.join(root, 'scripts', 'addon.sh'), '');
      fs.writeFileSync(path.join(root, 'scripts', 'vault.sh'), '');
      const manifest = path.join(root, 'addons', 'bitwarden', 'addon.json');
      const none = () => false;
      const ids = () => availableAddons(root, none, none).map((e) => e.id);
      fs.writeFileSync(manifest, JSON.stringify({ instances: {} }));
      expect(ids()).toEqual([]);
      fs.writeFileSync(manifest, JSON.stringify({ instances: { connect: {}, disconnect: {} } }));
      expect(ids()).toEqual(['bitwarden']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('availableAddons offers Todo lists only when the tree has the 0.3.15 manifest', () => {
    const none = () => false;
    expect(availableAddons('/stack', none, none, none, none, none)).toEqual([]);
    const withTodos = availableAddons('/stack', none, none, none, none, () => true);
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
