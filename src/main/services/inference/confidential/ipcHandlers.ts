import { handle } from '../../../ipc';
import type { ConfidentialService } from './confidentialService';

/**
 * The renderer's way to the confidential pool (ADR 0047 phase 3). These use `handle`, so a
 * service error rejects the invoke; a failed check while adding a provider is part of the
 * result, not an error.
 */
export function registerConfidentialHandlers(service: ConfidentialService): void {
  handle('confidential:get-state', () => service.state());
  handle('confidential:get-spend', () => service.spend());
  handle('confidential:add-provider', (_event, { id, apiKey }) => service.addProvider(id, apiKey));
  handle('confidential:remove-provider', (_event, { id }) => service.removeProvider(id));
  handle('confidential:set-settings', (_event, settings) => service.setSettings(settings));
  handle('confidential:rank', (_event, { modelId, privateProject, projectFloor }) =>
    service.rank(modelId, { privateProject, projectFloor })
  );
  handle('confidential:refresh', async () => {
    await service.refreshLive();
    return service.state();
  });
}
