import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ASSISTANT_STACK_PORTS } from '../../shared/assistantStackConstants';
import { resolveAssistantDataRoot } from '../services/assistant/assistantPaths';
import { parseEnv, upsertEnvLines } from '../services/assistant/stackEnv';

/**
 * Earlier dual-stack runs set API_SERVER_PORT to the host publish port (e.g. 18643) in the
 * managed install's api-server profile. Inside the container the process must listen on 8643
 * (mapped host→8643). The stack's bootstrap now writes it from HERMES_API_SERVER_PORT, which
 * Boundary always sets to the default, so nothing writes the host port again.
 */
export function repairApiServerListenPort(dataRoot = resolveAssistantDataRoot()): void {
  const envPath = path.join(dataRoot, 'hermes', 'profiles', 'api-server', '.env');
  if (!fs.existsSync(envPath)) return;
  const original = fs.readFileSync(envPath, 'utf8');
  const expected = String(DEFAULT_ASSISTANT_STACK_PORTS.apiServer);
  if (parseEnv(original).API_SERVER_PORT === expected) return;
  fs.writeFileSync(envPath, upsertEnvLines(original, { API_SERVER_PORT: expected }), 'utf8');
}
