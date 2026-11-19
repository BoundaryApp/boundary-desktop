import fs from 'node:fs';
import path from 'node:path';
import type { ConfidentialCatalog } from '../../../../shared/types/confidential';
import type { ConfidentialAdapter, ListedOffer } from './adapter';
import { parseCatalog } from './catalog';
import { createFakeAdapter } from './fakeAdapter';

/**
 * Dev stand-ins for the confidential providers, used while the flag is on and no real adapter
 * exists. The catalog is a bundled file; the adapters are fakes whose offers and prices come
 * from it, and whose behaviour is picked by a word in the API key.
 */

/** Reads `confidential/dev-catalog.json` under `resourcesDir`. Null when missing or invalid. */
export function loadDevCatalog(resourcesDir: string): ConfidentialCatalog | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'confidential', 'dev-catalog.json'), 'utf8'));
    const parsed = parseCatalog(raw);
    return parsed.ok === true ? parsed.catalog : null;
  } catch {
    return null;
  }
}

/**
 * A fake for one catalog provider. Key words: `bad` is rejected, `fail` fails the hardware
 * check, `notools` drops tool calls, `empty` has no balance, `sendfail` passes every add check
 * but answers every chat as rate limited for a minute, so the pool moves on. Chats answer with a
 * fixed text that names the provider and never call a tool.
 */
export function createDevAdapter(providerId: string, catalog: ConfidentialCatalog, apiKey: string): ConfidentialAdapter {
  const sendFails = apiKey.includes('sendfail');
  // `sendfail` holds `fail`, which must not also fail the hardware check.
  const words = apiKey.replaceAll('sendfail', '');
  const provider = catalog.providers.find((candidate) => candidate.id === providerId);
  const offers: ListedOffer[] = Object.values(provider?.offers ?? {}).map((offer) => ({
    providerModelId: offer.providerModelId,
    contextLength: offer.contextLength,
    precision: offer.precision,
    price: offer.price,
  }));
  return createFakeAdapter(providerId, {
    offers,
    balance: words.includes('empty') ? 0 : 10,
    attestation: words.includes('fail') ? 'fail' : 'pass',
    toolsWork: !words.includes('notools'),
    keyResult: words.includes('bad') ? { kind: 'bad-key' } : 'ok',
    chatResults: sendFails ? [{ kind: 'rate-limited', retryAfterMs: 60_000 }] : ['ok'],
    chatReply: 'dev-text',
    name: provider?.name ?? providerId,
  });
}
