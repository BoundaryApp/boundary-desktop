import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
  HermesCredentialRequestKind,
} from '../../../../shared/types/hermesChat';
import type { ServerRequest } from './vendor/json-rpc-channel';

/**
 * Hermes asks the client for a credential through these server requests and
 * waits for `{ value }`; an empty value means skipped. Hermes saves the answer
 * itself and the model only learns whether it was stored.
 *
 * The value passes renderer → main → WebSocket once. Never log it, never keep it.
 */
export const CREDENTIAL_REQUEST_KINDS: readonly HermesCredentialRequestKind[] = [
  'secret',
  'vault.unlock_prompt',
  'vault.save_login',
  'vault.code',
];

/** Generous cap; real keys and passwords are far shorter. */
const MAX_VALUE_LENGTH = 16 * 1024;

const pendingByRpcId = new Map<
  string,
  { request: ServerRequest; event: HermesChatCredentialRequestEvent }
>();

export function isCredentialRequestKind(method: string): method is HermesCredentialRequestKind {
  return (CREDENTIAL_REQUEST_KINDS as readonly string[]).includes(method);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parkCredentialRequest(
  request: ServerRequest
): HermesChatCredentialRequestEvent | null {
  if (!isCredentialRequestKind(request.method)) return null;
  const params = request.params ?? {};
  const sessionId = str(params.session_id);
  if (!sessionId) return null;

  const event: HermesChatCredentialRequestEvent = {
    rpcRequestId: request.id,
    sessionId,
    kind: request.method,
    replayed: Boolean(request.replayed),
  };
  switch (request.method) {
    case 'secret':
      event.envVar = str(params.env_var);
      event.prompt = str(params.prompt);
      if (!event.envVar) return null;
      break;
    case 'vault.unlock_prompt':
      event.backend = str(params.backend);
      event.displayName = str(params.display_name) ?? event.backend;
      break;
    case 'vault.save_login':
      event.origin = str(params.origin);
      event.site = str(params.site) ?? event.origin;
      if (!event.origin) return null;
      break;
    case 'vault.code':
      event.site = str(params.site);
      event.hint = str(params.hint);
      break;
  }

  pendingByRpcId.set(request.id, { request, event });
  return event;
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

export function respondToCredentialRequest(
  payload: HermesChatCredentialRespondPayload
): { success: boolean; error?: string } {
  const pending = pendingByRpcId.get(payload.rpcRequestId);
  if (!pending) {
    return { success: false, error: 'No pending credential request for that id' };
  }
  const { kind } = pending.event;

  let value = '';
  if (kind === 'vault.save_login') {
    const login = payload.login;
    if (login) {
      if (typeof login.identifier !== 'string' || login.identifier.length > MAX_VALUE_LENGTH) {
        return { success: false, error: 'Invalid username' };
      }
      if (!validValue(login.password)) {
        return { success: false, error: 'Enter a password' };
      }
      value = JSON.stringify({ identifier: login.identifier, password: login.password });
    }
  } else if (payload.value !== undefined) {
    if (!validValue(payload.value)) {
      return { success: false, error: 'Enter a value' };
    }
    value = payload.value;
  }

  pending.request.respond({ value });
  pendingByRpcId.delete(payload.rpcRequestId);
  return { success: true };
}

export function clearParkedCredentialRequests(): void {
  pendingByRpcId.clear();
}

export function listParkedCredentialRequests(): HermesChatCredentialRequestEvent[] {
  return Array.from(pendingByRpcId.values()).map((p) => p.event);
}
