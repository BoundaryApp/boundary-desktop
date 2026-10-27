import type {
  HermesApprovalChoice,
  HermesApprovalMcpCall,
  HermesChatApprovalEvent,
  HermesChatApprovalRespondPayload,
} from '../../../../shared/types/hermesChat';
import type { ServerRequest } from './vendor/json-rpc-channel';
import { ParkedRequests, type ParkedResponder } from './parkedRequests';

const parked = new ParkedRequests<HermesChatApprovalEvent>();

/** Approvals replayed from `approval.pending` get a synthetic rpc id with this prefix. */
export const REPLAYED_APPROVAL_PREFIX = 'pending:';

const VALID_CHOICES: readonly HermesApprovalChoice[] = [
  'once',
  'session',
  'always',
  'deny',
];

export function isHermesApprovalChoice(value: unknown): value is HermesApprovalChoice {
  return (
    typeof value === 'string' &&
    (VALID_CHOICES as readonly string[]).includes(value)
  );
}

/** Filter gateway-offered choices by allow_session / allow_permanent. */
export function filterApprovalChoices(
  choices: unknown,
  opts: {
    allowSession?: boolean | null;
    allowPermanent?: boolean | null;
    smartDenied?: boolean | null;
  }
): HermesApprovalChoice[] {
  const fallback: HermesApprovalChoice[] = opts.smartDenied
    ? ['once', 'deny']
    : ['once', 'session', 'always', 'deny'];
  const raw = Array.isArray(choices) ? choices : fallback;
  const filtered = raw.filter(isHermesApprovalChoice).filter((choice) => {
    if (choice === 'session' && opts.allowSession === false) return false;
    if (choice === 'always' && opts.allowPermanent === false) return false;
    return true;
  });
  return filtered.length > 0 ? filtered : ['once', 'deny'];
}

/** The `mcp` block of an approval, or undefined when it's missing or malformed. */
export function parseApprovalMcp(value: unknown): HermesApprovalMcpCall | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.server !== 'string' || !raw.server) return undefined;
  if (typeof raw.tool !== 'string' || !raw.tool) return undefined;
  const args = raw.arguments;
  return {
    server: raw.server,
    tool: raw.tool,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : null,
    ...(typeof raw.tool_call_id === 'string' ? { toolCallId: raw.tool_call_id } : {}),
  };
}

/**
 * Park an approval until the user answers it. `respond` sends the answer (the request's own by
 * default). One approval reaches Boundary twice when a live request and an `approval.pending`
 * replay both carry it: the live one is kept, since it answers over the socket that asked.
 */
export function parkApprovalRequest(
  request: ServerRequest,
  respond: ParkedResponder = request.respond
): HermesChatApprovalEvent | null {
  if (request.method !== 'approval') return null;

  const params = request.params ?? {};
  const sessionId =
    typeof params.session_id === 'string' ? params.session_id : '';
  const approvalRequestId =
    typeof params.request_id === 'string' ? params.request_id : request.id;
  if (!sessionId) return null;

  const allowSession =
    typeof params.allow_session === 'boolean' ? params.allow_session : undefined;
  const allowPermanent =
    typeof params.allow_permanent === 'boolean'
      ? params.allow_permanent
      : undefined;
  const smartDenied = params.smart_denied === true;
  const mcp = parseApprovalMcp(params.mcp);

  const event: HermesChatApprovalEvent = {
    rpcRequestId: request.id,
    sessionId,
    approvalRequestId,
    command: typeof params.command === 'string' ? params.command : undefined,
    description:
      typeof params.description === 'string' ? params.description : undefined,
    toolName: typeof params.tool_name === 'string' ? params.tool_name : undefined,
    choices: filterApprovalChoices(params.choices, {
      allowSession,
      allowPermanent,
      smartDenied,
    }),
    allowSession,
    allowPermanent,
    smartDenied: smartDenied || undefined,
    replayed: Boolean(request.replayed),
    ...(mcp ? { mcp } : {}),
  };

  const same = parked.find(
    (other) => other.sessionId === sessionId && other.approvalRequestId === approvalRequestId
  );
  if (same && same.rpcRequestId !== request.id) {
    if (isReplayedApproval(request.id)) return same;
    parked.drop(same.rpcRequestId);
  }
  parked.park(event, respond);
  return event;
}

function isReplayedApproval(rpcRequestId: string): boolean {
  return rpcRequestId.startsWith(REPLAYED_APPROVAL_PREFIX);
}

/**
 * Answer a parked approval. The choice is checked against the ones offered before anything
 * is sent, and the approval stays parked when the answer couldn't be sent.
 */
export async function respondToParkedApproval(
  payload: HermesChatApprovalRespondPayload
): Promise<{ success: boolean; error?: string }> {
  const event = parked.get(payload.rpcRequestId);
  if (!event) {
    return { success: false, error: 'No pending approval for that request' };
  }
  if (!isHermesApprovalChoice(payload.choice)) {
    return { success: false, error: 'Invalid approval choice' };
  }
  if (!event.choices.includes(payload.choice)) {
    return { success: false, error: 'Choice not offered for this approval' };
  }
  return parked.answer(payload.rpcRequestId, {
    choice: payload.choice,
    ...(payload.all ? { all: true } : {}),
  });
}

/** Forget a parked approval Hermes withdrew; true when one was parked. */
export function dropParkedApproval(rpcRequestId: string): boolean {
  return parked.drop(rpcRequestId);
}

/** Forget every parked approval and return them. */
export function clearParkedApprovals(): HermesChatApprovalEvent[] {
  return parked.clear();
}

/** Approvals waiting on the user; with `sessionIds`, only those sessions'. */
export function listParkedApprovals(sessionIds?: readonly string[]): HermesChatApprovalEvent[] {
  return parked.list(sessionIds);
}
