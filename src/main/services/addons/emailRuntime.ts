import { persistDebugLog } from '../../persistDebugLog';
import { getAssistantStackAccess } from '../assistant/AssistantStackService';
import { isLocalAssistantStackMode } from '../assistant/localStackMode';
import { EMAIL_ENTRY } from './addonCatalog';
import { checkAddonFit } from './addonFitCheck';
import { runExclusive } from './addonLock';
import { createEmailService, type EmailService } from './emailAddon';
import type { EmailInstallerDeps } from './emailInstaller';
import { runOnStack, runPlainOnStack, stackPaths } from './stackScripts';

// Email's service and installer on the live stack: scripts run in the stack root with the
// stack's script environment, which in the managed stack carries Boundary's compose project,
// files and env. The indexer's log and restart go through the same compose access.

/** Counts, codes and outcomes only: no address, host, user, slug or mailbox name. */
const log = (message: string, data: Record<string, unknown>) => persistDebugLog('addons', `email ${message}`, data);

let shared: EmailService | null = null;

export function getEmailService(): EmailService {
  shared ??= createEmailService({
    paths: stackPaths,
    plain: (args, options) => runPlainOnStack('addon.sh', args, options),
    run: runOnStack,
    indexerLog: async () => {
      try {
        const { stdout } = await getAssistantStackAccess().compose(
          ['--profile', 'email', 'logs', '--timestamps', '--no-log-prefix', '--tail', '200', 'email-indexer'],
          { timeout: 30_000 }
        );
        return stdout;
      } catch {
        return null;
      }
    },
    restartIndexer: async () => {
      await getAssistantStackAccess().compose(['--profile', 'email', 'restart', 'email-indexer'], { timeout: 120_000 });
    },
    exclusive: runExclusive,
    now: () => new Date(),
    log,
  });
  return shared;
}

export function createDefaultEmailInstallerDeps(): EmailInstallerDeps {
  return {
    service: getEmailService(),
    run: runOnStack,
    paths: stackPaths,
    checkFit: async () => (await checkAddonFit(EMAIL_ENTRY)).fit,
    isLocalStack: isLocalAssistantStackMode,
    exclusive: runExclusive,
    log,
  };
}
