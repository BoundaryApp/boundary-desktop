import { handleResult } from '../../../ipc';
import type {
  HermesAgentCreatePayload,
  HermesAgentSoulPayload,
  HermesAgentUpdatePayload,
} from '../../../../shared/types/hermesChat';
import {
  createHermesAgent,
  getHermesAgentSoul,
  listHermesAgents,
  revealHermesAgentSoul,
  updateHermesAgent,
} from './hermesAgents';
import { ensureOrchestratorAgent } from './hermesOrchestrator';

export function registerAgentHandlers(): void {
  handleResult('hermes-agents:list', async () => {
    void ensureOrchestratorAgent();
    return listHermesAgents();
  });

  handleResult('hermes-agents:create', async (_event, payload: HermesAgentCreatePayload) =>
    createHermesAgent(payload)
  );

  handleResult('hermes-agents:update', async (_event, payload: HermesAgentUpdatePayload) =>
    updateHermesAgent(payload)
  );

  handleResult('hermes-agents:soul', async (_event, payload: HermesAgentSoulPayload) =>
    getHermesAgentSoul(payload)
  );

  handleResult('hermes-agents:reveal-soul', async (_event, payload: HermesAgentSoulPayload) =>
    revealHermesAgentSoul(payload)
  );
}
