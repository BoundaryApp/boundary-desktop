import { describe, expect, it, vi } from 'vitest';
import { SOVEREIGN_AGENT_STACK_VERSION } from '../../../../../shared/assistantStackConstants';
import { AssistantStackTooOldError, refuseLocalStackOlderThanPin } from '../stackPinCheck';
import { JsonRpcGatewayError } from '../vendor/json-rpc-channel';

const ROOT = '/Users/dev/assistant';

/** What a v0.3.3+ gateway advertises (stack CHANGELOG v0.3.3). */
const PINNED_CAPS = {
  turn_heartbeat: true,
  turn_heartbeat_s: 30,
  session_live_status: true,
  client_context: true,
};

function gateway(answer: () => Promise<unknown>) {
  return { request: vi.fn(answer), close: vi.fn() };
}

describe('refuseLocalStackOlderThanPin (decision D2)', () => {
  it('lets a gateway with the v0.3.3 capabilities through', async () => {
    const client = gateway(async () => PINNED_CAPS);
    await expect(refuseLocalStackOlderThanPin(client, ROOT)).resolves.toBeUndefined();
    expect(client.request).toHaveBeenCalledWith('gateway.capabilities', {});
    expect(client.close).not.toHaveBeenCalled();
  });

  it('refuses a gateway missing them, naming the pinned version, and closes it', async () => {
    const client = gateway(async () => ({ turn_heartbeat: false }));
    const refusal = refuseLocalStackOlderThanPin(client, ROOT);
    await expect(refusal).rejects.toBeInstanceOf(AssistantStackTooOldError);
    await expect(refusal).rejects.toThrow(SOVEREIGN_AGENT_STACK_VERSION);
    await expect(refusal).rejects.toThrow(ROOT);
    await expect(refusal).rejects.toThrow(/turn\.heartbeat, session\.live_status, client_context/);
    expect(client.close).toHaveBeenCalled();
  });

  it('refuses a gateway that has no gateway.capabilities method', async () => {
    const client = gateway(async () => {
      throw new JsonRpcGatewayError('method not found: gateway.capabilities', { code: -32601 });
    });
    await expect(refuseLocalStackOlderThanPin(client, ROOT)).rejects.toBeInstanceOf(
      AssistantStackTooOldError
    );
  });

  it('does not refuse when the connection fails before the gateway answers', async () => {
    const client = gateway(async () => {
      throw new Error('not connected');
    });
    await expect(refuseLocalStackOlderThanPin(client, ROOT)).resolves.toBeUndefined();
    expect(client.close).not.toHaveBeenCalled();
  });
});
