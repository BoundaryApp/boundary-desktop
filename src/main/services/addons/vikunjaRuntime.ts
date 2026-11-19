import { persistDebugLog } from '../../persistDebugLog';
import { dropAgentMcpEnv, syncAgentMcpServers } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { VIKUNJA_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { addPendingChange, removePendingChanges } from './pendingRestart';
import { createVikunjaService, type VikunjaService } from './vikunjaAddon';
import type { VikunjaInstallerDeps } from './vikunjaInstaller';
import { runOnStack, runPlainOnStack, stackPaths } from './stackScripts';

// Todo lists' service and installer on the live stack (stackScripts.ts runs the scripts).

/** Codes and outcomes only: no URL, token or list name. */
const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `vikunja ${message}`, data);

/** The restart bar's line when agents' profiles changed after Todo lists turned on. */
const AGENT_TODOS_PENDING = 'Agents get Todo lists after the assistant restarts.';
const AGENT_TODOS_GONE = 'Agents stop trying Todo lists after the assistant restarts.';

/** The `.env` key the stack's `todos` entry reads its token from (addons/vikunja/addon.json `mcp.auth`). */
const TODOS_TOKEN_ENV = 'TODOS_KEY';

let shared: VikunjaService | null = null;

export function getVikunjaService(): VikunjaService {
  shared ??= createVikunjaService({
    paths: stackPaths,
    plain: (args, options) => runPlainOnStack('addon.sh', args, options),
    run: runOnStack,
    log,
  });
  return shared;
}

export function createDefaultVikunjaInstallerDeps(): VikunjaInstallerDeps {
  return {
    service: getVikunjaService(),
    run: runOnStack,
    paths: stackPaths,
    checkFit: async () => (await checkAddonFit(VIKUNJA_ENTRY)).fit,
    isLocalStack: isLocalAssistantStackMode,
    exclusive: runExclusive,
    log,
    afterEnable: async () => {
      try {
        const { changed } = await syncAgentMcpServers();
        log('agents synced', { changed });
        if (changed) {
          removePendingChanges((text) => text === AGENT_TODOS_GONE);
          addPendingChange(AGENT_TODOS_PENDING);
        }
      } catch (error) {
        log('agents not synced', { error: error instanceof Error ? error.name : 'unknown' });
      }
    },
    afterDisable: async () => {
      try {
        const { changed } = await dropAgentMcpEnv([TODOS_TOKEN_ENV]);
        log('agents token dropped', { changed });
        if (changed) {
          removePendingChanges((text) => text === AGENT_TODOS_PENDING);
          addPendingChange(AGENT_TODOS_GONE);
        }
      } catch (error) {
        log('agents token not dropped', { error: error instanceof Error ? error.name : 'unknown' });
      }
    },
  };
}
