import { app } from 'electron';
import Store from 'electron-store';
import { handle } from '../../ipc';
import { broadcast } from '../windows';
import { isAssistantStackSetupComplete } from '../assistant/AssistantStackStore';
import { closeUpdatedCard } from '../updates/ipcHandlers';
import { WhatsNewService, type WhatsNewStore, type WhatsNewStoreShape } from './WhatsNewService';

let service: WhatsNewService | null = null;

/** Classifies this launch and serves the release notes state (ADR 0059). */
export function registerWhatsNewHandlers(): void {
  const store = new Store<WhatsNewStoreShape>({ name: 'whats-new' });
  service = new WhatsNewService({
    currentVersion: app.getVersion(),
    setupComplete: isAssistantStackSetupComplete,
    store: store as unknown as WhatsNewStore,
    // The notes replace the updater's own card for a version that has them.
    closeUpdated: closeUpdatedCard,
    onChange: (snapshot) => broadcast('whats-new:state', snapshot),
  });

  handle('whats-new:get-state', () => service?.snapshot() ?? null);
  handle('whats-new:mark-seen', (_event, version) => service?.markSeen(version));
  handle('whats-new:set-popups', (_event, on) => service?.setPopups(on));
}
