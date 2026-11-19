import type {
  HermesChatCredentialRequestEvent,
  HermesChatCredentialRespondPayload,
  HermesChatRespondResult,
  HermesCredentialRequestKind,
} from '../../../../shared/types/hermesChat';
import type { ServerRequest } from './vendor/json-rpc-channel';
import { ParkedRequests, type ParkedResponder } from './parkedRequests';

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
  'vault.create_login',
  'vault.capture_secret',
];

/** Generous cap; real keys and passwords are far shorter. */
const MAX_VALUE_LENGTH = 16 * 1024;

const parked = new ParkedRequests<HermesChatCredentialRequestEvent>();

export function isCredentialRequestKind(method: string): method is HermesCredentialRequestKind {
  return (CREDENTIAL_REQUEST_KINDS as readonly string[]).includes(method);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Park a credential request until the user answers it; `respond` sends the answer. */
export function parkCredentialRequest(
  request: ServerRequest,
  respond: ParkedResponder = request.respond
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
    case 'vault.create_login':
      event.origin = str(params.origin);
      event.site = str(params.site) ?? event.origin;
      event.identifier = str(params.identifier);
      event.regenerate = params.regenerate === true;
      if (!event.origin) return null;
      break;
    case 'vault.capture_secret':
      event.origin = str(params.origin);
      event.site = str(params.site) ?? event.origin;
      event.name = str(params.name);
      event.destination =
        params.destination === 'env' || params.destination === 'viewer' ? params.destination : undefined;
      event.last4 = str(params.last4);
      event.replaces = params.replaces === true;
      if (!event.origin || !event.name || !event.destination) return null;
      break;
  }

  parked.park(event, respond);
  return event;
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH;
}

/** Answer a parked credential request. It stays parked when the answer couldn't be sent. */
export async function respondToCredentialRequest(
  payload: HermesChatCredentialRespondPayload
): Promise<HermesChatRespondResult> {
  const pending = parked.get(payload.rpcRequestId);
  if (!pending) {
    return { success: false, error: 'No pending credential request for that id', errorCode: 'not-pending' };
  }
  const { kind } = pending;

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
  } else if (kind === 'vault.create_login') {
    // Hermes reads `{"generate": true}` or `{"password": "..."}`; "" declines.
    const answer = payload.createLogin;
    if (answer) {
      if ('password' in answer) {
        if (!validValue(answer.password)) {
          return { success: false, error: 'Enter a password' };
        }
        value = JSON.stringify({ password: answer.password });
      } else if (answer.generate === true) {
        value = JSON.stringify({ generate: true });
      } else {
        return { success: false, error: 'Invalid answer' };
      }
    }
  } else if (kind === 'vault.capture_secret') {
    // Hermes reads "approve"; anything else declines. Boundary has nowhere to keep a key handed
    // to the viewer yet, so it never approves one: Hermes would hold it until it expired.
    if (payload.approve === true) {
      if (pending.destination !== 'env') {
        return { success: false, error: "Keys can't be handed to this app yet" };
      }
      value = 'approve';
    }
  } else if (payload.value !== undefined) {
    if (!validValue(payload.value)) {
      return { success: false, error: 'Enter a value' };
    }
    value = payload.value;
  }

  return parked.answer(payload.rpcRequestId, { value });
}

/** Forget a parked credential request Hermes withdrew; true when one was parked. */
export function dropParkedCredentialRequest(rpcRequestId: string): boolean {
  return parked.drop(rpcRequestId);
}

/** Forget every parked credential request and return them. */
export function clearParkedCredentialRequests(): HermesChatCredentialRequestEvent[] {
  return parked.clear();
}

export function listParkedCredentialRequests(): HermesChatCredentialRequestEvent[] {
  return parked.list();
}
