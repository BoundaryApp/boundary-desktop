import type {
  HermesApprovalChoice,
  HermesApprovalMcpCall,
  HermesChatApprovalEvent,
  HermesChatApprovalRespondPayload,
} from '../../../../shared/types/hermesChat';
import type { ServerRequest } from './vendor/json-rpc-channel';

type PendingApproval = {
  request: ServerRequest;
  event: HermesChatApprovalEvent;
};

const pendingByRpcId = new Map<string, PendingApproval>();

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

export function parkApprovalRequest(request: ServerRequest): HermesChatApprovalEvent | null {
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
  const patternKey =
    typeof params.pattern_key === 'string' ? params.pattern_key : undefined;
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
    patternKey,
    replayed: Boolean(request.replayed),
    ...(mcp ? { mcp } : {}),
  };

  pendingByRpcId.set(request.id, { request, event });
  return event;
}

export function respondToParkedApproval(
  payload: HermesChatApprovalRespondPayload
): { success: boolean; error?: string } {
  const pending = pendingByRpcId.get(payload.rpcRequestId);
  if (!pending) {
    return { success: false, error: 'No pending approval for that request' };
  }
  if (!isHermesApprovalChoice(payload.choice)) {
    return { success: false, error: 'Invalid approval choice' };
  }
  if (!pending.event.choices.includes(payload.choice)) {
    return { success: false, error: 'Choice not offered for this approval' };
  }

  pending.request.respond({
    choice: payload.choice,
    ...(payload.all ? { all: true } : {}),
  });
  pendingByRpcId.delete(payload.rpcRequestId);
  return { success: true };
}

export function clearParkedApprovals(): void {
  pendingByRpcId.clear();
}

export function listParkedApprovals(): HermesChatApprovalEvent[] {
  return Array.from(pendingByRpcId.values()).map((p) => p.event);
}
