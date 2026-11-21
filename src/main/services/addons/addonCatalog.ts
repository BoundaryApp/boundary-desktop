import type { AddonCatalogEntry } from '../../../shared/types/addons';
import type { StackFiles } from '../stackHost/types';
import { actualAvailable } from './actualAddon';
import { bitwardenOffered } from './bitwardenAddon';
import { builtinAddonAvailable } from './builtinAddons';
import { emailAvailable } from './emailAddon';
import { vikunjaAvailable } from './vikunjaAddon';

export const TWENTY_ENTRY: AddonCatalogEntry = {
  id: 'twenty',
  name: 'Twenty CRM',
  summary: 'Contacts, companies and deals that your agents can look up and keep current.',
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
};

/**
 * Actual Budget (spec decision 19). No Actual service has a memory reservation in compose, so
 * the figures are estimates: the server, the two MCP containers idle, and one connected budget
 * (about 200 MB across both MCP containers, CR 0026's measurement). `actual-mcp` is built from
 * the stack's tree, not pulled, so the download is the server image plus the build's base.
 */
export const ACTUAL_ENTRY: AddonCatalogEntry = {
  id: 'actual',
  name: 'Actual Budget',
  summary: 'Your budgets, which agents can look up and, if you allow it, change.',
  version: '26.11.0',
  profile: 'budget',
  flags: ['ACTUAL_LOCAL_ENABLED', 'ACTUAL_MCP_ENABLED'],
  services: ['actual-server', 'actual-mcp-rw', 'actual-mcp-ro'],
  ownServices: { profile: 'budget-local', services: ['actual-server'] },
  reserveMiB: 640,
  limitMiB: 1024,
  downloadBytes: 600_000_000,
  port: { envKey: 'ACTUAL_PORT', default: 5006 },
  restartsHermes: false,
  account: null,
};

/**
 * Bitwarden logins (spec decision 26): the broker beside Hermes, and from stack v0.3.16
 * `bitwarden-signin`, the Chromium that fills sign-in pages. Both images are built from the
 * stack's tree, the signer's FROM the Hermes image already on this Mac, so the download is the
 * broker's. Compose gives neither a memory reservation; it caps the signer at 768 MiB. The
 * reservation is an estimate (the broker's Python and one `bw` CLI, plus the signer idle between
 * sign-ins), and the limit adds the signer's cap to the broker's 512 MiB estimate. Neither
 * publishes a port. The broker stays first: the fit check reads it as the add-on's server.
 */
export const BITWARDEN_ENTRY: AddonCatalogEntry = {
  id: 'bitwarden',
  name: 'Bitwarden',
  summary: 'Sign in to websites with logins from one folder of your Bitwarden vault.',
  version: '1.0.0',
  profile: 'bitwarden',
  flags: ['BITWARDEN_ENABLED'],
  services: ['bitwarden-broker', 'bitwarden-signin'],
  reserveMiB: 320,
  limitMiB: 1280,
  downloadBytes: 300_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

/**
 * Email (IMAP accounts): `email-indexer` and `email-mcp` run under the `email` profile, and the
 * drafts pair under `email-drafts`. Compose gives them no memory reservation, so the figures are
 * estimates (the spec's open-work item). `email-imap` is built from the stack's tree, not pulled.
 */
export const EMAIL_ENTRY: AddonCatalogEntry = {
  id: 'email',
  name: 'Email',
  summary: 'Mail from your IMAP accounts that agents can search and read. They can’t send.',
  version: '1.0.0',
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
};

/**
 * Todo lists (Vikunja 2.8, CR 0032): `vikunja` and `vikunja-proxy` under the `todo` profile, with
 * its data in the shared Postgres that Boundary already runs (`db`). Compose gives neither a memory
 * reservation, so the figures are estimates: Vikunja's Go server idle with one person's lists, and
 * the proxy's few MiB. The download is both images; Postgres is already on this Mac.
 */
export const VIKUNJA_ENTRY: AddonCatalogEntry = {
  id: 'vikunja',
  name: 'Todo lists',
  summary: 'Todo lists you and your agents both edit, with a web app on this Mac.',
  version: '2.8.0',
  profile: 'todo',
  flags: ['VIKUNJA_MCP_ENABLED'],
  services: ['vikunja', 'vikunja-proxy'],
  reserveMiB: 192,
  limitMiB: 384,
  downloadBytes: 300_000_000,
  port: { envKey: 'VIKUNJA_PORT', default: 3456 },
  restartsHermes: false,
  account: null,
};

/**
 * n8n with the GPT Researcher API its starter research workflow calls (addons/n8n/addon.json,
 * stack 0.3.13): `n8n-import` runs once before `n8n` starts. `automation` is already one of
 * Boundary's profiles, for `gptr-mcp`, so turning n8n on adds no profile; `up` leaves n8n's services
 * out while it's off. Compose sets no memory limit for either, so the figures are estimates. Its
 * port is one of Boundary's own (`ports.n8n`), so the fit check doesn't look at it.
 */
export const N8N_ENTRY: AddonCatalogEntry = {
  id: 'n8n',
  name: 'n8n',
  summary: 'Workflows that run on a schedule or a webhook, with starter workflows for research.',
  version: '2.47.4',
  profile: 'automation',
  flags: ['AUTOMATION_ENABLED'],
  services: ['n8n', 'gpt-researcher'],
  reserveMiB: 1024,
  limitMiB: 2048,
  downloadBytes: 1_500_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

/**
 * LightRAG over the active workspace, with Neo4j as its graph store, and five read-only tools for
 * agents through `lightrag-mcp` (addons/lightrag/addon.json, stack 0.3.13). The `rag` profile holds
 * all three; `enable` names `lightrag` and `lightrag-mcp`, and Neo4j starts as `lightrag`'s
 * dependency. Neo4j's heap and page cache come to 1.5 GB at most; LightRAG has no limit, so the
 * figure is the stack's older estimate. Its ports are Boundary's own (`ports.lightrag`, `ports.neo4j`).
 */
export const LIGHTRAG_ENTRY: AddonCatalogEntry = {
  id: 'lightrag',
  name: 'LightRAG',
  summary: 'A knowledge graph over your documents, stored in Neo4j, so agents can answer from them.',
  version: '1.5.7',
  profile: 'rag',
  flags: ['LIGHTRAG_MCP_ENABLED'],
  services: ['lightrag', 'lightrag-mcp', 'neo4j'],
  reserveMiB: 3072,
  limitMiB: 4096,
  downloadBytes: 2_000_000_000,
  port: null,
  restartsHermes: false,
  account: null,
};

/**
 * Add-ons the stack's files can run. Twenty needs `scripts/crm.sh` (stack 0.3.10 and
 * later); Actual needs `scripts/addon.sh` and a manifest with the init and connect hooks (0.3.13); Bitwarden
 * needs `scripts/vault.sh` and a manifest with accounts as instances (CR 0028, after 0.3.12); Email needs `scripts/addon.sh` and a manifest
 * with accounts as instances and a mailboxes command (0.3.13); Todo lists needs `scripts/addon.sh`
 * and a manifest with the `prepare` hook (0.3.15). n8n and LightRAG need `scripts/addon.sh` and
 * their manifests' `builtin` blocks (0.3.13).
 */
export async function availableAddons(files: StackFiles): Promise<AddonCatalogEntry[]> {
  const [twenty, actual, bitwarden, email, vikunja, n8n, lightrag] = await Promise.all([
    files.exists('stack', 'scripts/crm.sh').catch(() => false),
    actualAvailable(files),
    bitwardenOffered(files),
    emailAvailable(files),
    vikunjaAvailable(files),
    builtinAddonAvailable(files, 'n8n'),
    builtinAddonAvailable(files, 'lightrag'),
  ]);
  const entries: AddonCatalogEntry[] = [];
  if (twenty) entries.push({ ...TWENTY_ENTRY });
  if (actual) entries.push({ ...ACTUAL_ENTRY });
  if (bitwarden) entries.push({ ...BITWARDEN_ENTRY });
  if (email) entries.push({ ...EMAIL_ENTRY });
  if (vikunja) entries.push({ ...VIKUNJA_ENTRY });
  if (n8n) entries.push({ ...N8N_ENTRY });
  if (lightrag) entries.push({ ...LIGHTRAG_ENTRY });
  return entries;
}
