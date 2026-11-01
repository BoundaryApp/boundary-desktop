import { isAssistantStackSetupComplete, repairStoredAssistantPorts } from '../services/assistant/AssistantStackStore';
import { listStoredHermesProjects } from '../services/assistant/hermes/hermesProjectStore';
import { recordSetupHistoryOnce } from '../services/setup/SetupProgressStore';
import { repairApiServerListenPort } from './assistantStack';
import { dropWipedCircleReferences } from './circleReferences';
import {
  claimLegacyStoreForActiveStack,
  dropBuiltinStandingDmInEveryStore,
  movePendingChannelMessagesInEveryStore,
  renameLegacyBuiltinInEveryStore,
} from './hermesAgentsStores';
import { type Migration, runMigrations } from './runner';

// The next minor release after the version in package.json (0.0.1) when these were moved here.
// An install that runs that release has run them, so they can be deleted after it.
const NEXT_MINOR = '0.1.0';

/** In the order they run. Append new ones; delete one once its `removeAfter` has shipped. */
const MIGRATIONS: readonly Migration[] = [
  {
    // Phase-1 store entries had only the core ports offset.
    id: 'assistant-stack-complete-ports',
    removeAfter: NEXT_MINOR,
    run: repairStoredAssistantPorts,
  },
  {
    id: 'api-server-listen-port',
    removeAfter: NEXT_MINOR,
    run: () => repairApiServerListenPort(),
  },
  {
    id: 'hermes-agents-claim-pre-split-store',
    removeAfter: NEXT_MINOR,
    run: () => claimLegacyStoreForActiveStack(),
  },
  {
    id: 'hermes-agents-pending-channel-messages',
    removeAfter: NEXT_MINOR,
    run: () => movePendingChannelMessagesInEveryStore(),
  },
  {
    id: 'hermes-agents-rename-builtin',
    removeAfter: NEXT_MINOR,
    run: () => renameLegacyBuiltinInEveryStore(),
  },
  {
    id: 'hermes-agents-drop-builtin-standing-dm',
    removeAfter: NEXT_MINOR,
    run: () => dropBuiltinStandingDmInEveryStore(),
  },
  {
    // Before any setup handler runs, so setup finishing in this version can't count as an
    // upgrade. The renderer reads the facts it records.
    id: 'setup-history',
    removeAfter: NEXT_MINOR,
    run: () =>
      recordSetupHistoryOnce({
        setupComplete: isAssistantStackSetupComplete(),
        hasProjects: listStoredHermesProjects().length > 0,
      }),
  },
  {
    // Once only, not a check at each start: a Circle the user leaves later keeps its model
    // selected (ADR 0036 §5), so this never returns false to run again.
    id: 'circles-drop-wiped-references',
    removeAfter: NEXT_MINOR,
    run: () => dropWipedCircleReferences(),
  },
];

/** Call once at startup, before the services that read stored data. */
export function runStartupMigrations(): void {
  runMigrations(MIGRATIONS);
}
