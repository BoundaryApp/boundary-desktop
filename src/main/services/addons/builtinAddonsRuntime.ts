import { persistDebugLog } from '../../persistDebugLog';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { LIGHTRAG_ENTRY, N8N_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import {
  createBuiltinAddonInstaller,
  createBuiltinAddonService,
  type BuiltinAddonId,
  type BuiltinAddonInstaller,
} from './builtinAddons';
import { composeOnStack, runOnStack, stackPaths } from './stackScripts';

// n8n's and LightRAG's installers on the live stack (stackScripts.ts runs the scripts).

/** Codes and outcomes only. */
const logFor = (id: BuiltinAddonId) => (message: string, data: Record<string, unknown>) =>
  persistDebugLog('addons', `${id} ${message}`, data);

/**
 * After LightRAG turns off: stop Neo4j. `addon.sh disable lightrag` stops a `uses` service only
 * when `compose config --services` no longer lists it, and the COMPOSE_PROFILES Boundary hands the
 * script was built while `rag` was still on, so it leaves Neo4j running. Naming `rag` lets Compose
 * find the service now that the profile is off. Its `neo4j_data` volume stays.
 */
async function stopNeo4j(log: ReturnType<typeof logFor>): Promise<void> {
  try {
    await composeOnStack(['stop', 'neo4j'], { profiles: ['rag'], timeoutMs: 120_000 });
    log('neo4j stopped', {});
  } catch (error) {
    log('neo4j not stopped', { error: error instanceof Error ? error.name : 'unknown' });
  }
}

function createInstaller(id: BuiltinAddonId): BuiltinAddonInstaller {
  const entry = id === 'n8n' ? N8N_ENTRY : LIGHTRAG_ENTRY;
  const log = logFor(id);
  const service = createBuiltinAddonService(id, { paths: stackPaths, run: runOnStack, log });
  return createBuiltinAddonInstaller(id, entry.name, {
    service,
    run: runOnStack,
    paths: stackPaths,
    checkFit: async () => (await checkAddonFit(entry)).fit,
    isLocalStack: isLocalAssistantStackMode,
    exclusive: runExclusive,
    log,
    afterDisable: id === 'lightrag' ? () => stopNeo4j(log) : async () => {},
  });
}

export function createBuiltinAddonInstallers(): Record<BuiltinAddonId, BuiltinAddonInstaller> {
  return { n8n: createInstaller('n8n'), lightrag: createInstaller('lightrag') };
}
