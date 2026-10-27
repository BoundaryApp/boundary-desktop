import { redactSecrets } from '../../secrets/redact';
import { JSON_RPC_METHOD_NOT_FOUND, JsonRpcGatewayError } from './vendor/json-rpc-channel';

/**
 * Text for a failed gateway call that a user can read: `methodMissing` when this Hermes lacks the
 * method, Hermes's own message for a refusal, a hint when the gateway can't be reached, else the
 * error's message. `secrets` are redacted from any text taken from the error.
 */
export function gatewayErrorText(
  err: unknown,
  secrets: readonly string[],
  copy: { methodMissing: string; fallback: string; maxLength?: number }
): string {
  if (err instanceof JsonRpcGatewayError) {
    if (err.code === JSON_RPC_METHOD_NOT_FOUND) return copy.methodMissing;
    return redactSecrets(err.message, secrets) || 'Hermes refused the request.';
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/connect|ticket|ECONNREFUSED|socket/i.test(message)) {
    return 'Couldn’t reach Hermes. Start the agent stack and try again.';
  }
  return redactSecrets(message, secrets).slice(0, copy.maxLength) || copy.fallback;
}
