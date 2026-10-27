import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../../shared/assistantStackConstants';
import { JsonRpcGatewayError } from './vendor/json-rpc-channel';

/**
 * `gateway.capabilities` flags that stack v0.3.3 added (turn heartbeat, session.live_status,
 * client_context). A gateway without them predates the pinned stack. v0.3.4 left the wire
 * contract unchanged, so the gateway can't tell v0.3.3 from the pin; v0.3.3 runs fine.
 */
const PIN_CAPABILITIES = [
  { key: 'turn_heartbeat', name: 'turn.heartbeat' },
  { key: 'session_live_status', name: 'session.live_status' },
  { key: 'client_context', name: 'client_context' },
] as const;

export class AssistantStackTooOldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantStackTooOldError';
  }
}

/**
 * A local stack can be any checkout. Ask its gateway what it supports and refuse one older
 * than the pinned stack (decision D2), closing the connection. A connection that fails before
 * the gateway answers is left to the caller's usual error handling.
 */
export async function refuseLocalStackOlderThanPin(
  client: { request: (method: string, params: Record<string, unknown>) => Promise<unknown>; close: () => void },
  root: string
): Promise<void> {
  let caps: Record<string, unknown>;
  try {
    const answer = await client.request('gateway.capabilities', {});
    caps = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  } catch (error) {
    // The gateway answered, without a gateway.capabilities method.
    if (!(error instanceof JsonRpcGatewayError)) return;
    caps = {};
  }
  const missing = PIN_CAPABILITIES.filter(({ key }) => caps[key] !== true).map(({ name }) => name);
  if (missing.length === 0) return;
  client.close();
  throw new AssistantStackTooOldError(
    `The local agent stack at ${root} is older than ${SOVEREIGN_AGENT_STACK_VERSION}, the ` +
      `version this Boundary needs. Its gateway doesn't offer ${missing.join(', ')} ` +
      `(added in v0.3.3). Update the checkout to ${SOVEREIGN_AGENT_STACK_VERSION} or later, ` +
      'restart its stack, then reopen the chat.'
  );
}
