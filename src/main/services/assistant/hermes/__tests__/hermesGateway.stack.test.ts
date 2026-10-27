/**
 * Stack contract: the gateway on the dashboard's `/api/ws` (ADR 0031 §1). Runs only under
 * `bun run test:stack`.
 *
 * Two kinds of check:
 * - The catalog. Boundary's HermesGatewaySession methods are run against a recording client to
 *   collect each method and the param keys it sends; with the calls Boundary passes through
 *   (vault, MCP, the vendored channel's own) and the events and server requests it handles, they
 *   are checked against Hermes's contract registry (`tui_gateway.contracts`), imported read-only
 *   in the container. The stack's overlays add a few names at runtime; those are listed below and
 *   each is covered by a live call.
 * - Live calls. Boundary's own session dials the gateway (password login, ws-ticket, `/api/ws`)
 *   and calls the methods that only read, on one session it creates. That session is never sent
 *   a message, so Hermes doesn't store it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HermesGatewaySession } from '../hermesGatewaySession';
import { DM_HISTORY_BUDGET } from '../hermesAgents';
import { CREDENTIAL_REQUEST_KINDS } from '../hermesCredentialRequests';
import { refuseLocalStackOlderThanPin } from '../stackPinCheck';
import type { JsonRpcGatewayClient } from '../vendor';
import {
  probeStack,
  pythonJsonInHermes,
  skipNote,
  type StackTarget,
} from '../../__tests__/stackHarness';

const probe = await probeStack();

interface Call {
  method: string;
  keys: string[];
}

/** Answers that let each HermesGatewaySession method run to its request. */
const CANNED: Record<string, unknown> = {
  'session.create': { session_id: 'rec-session' },
  'session.resume': { session_id: 'rec-session' },
  'projects.for_cwd': { cwd: '/rec' },
  'tools.list': { toolsets: [{ name: 'rec-toolset', enabled: true }] },
  'tools.configure': { enabled_toolsets: ['rec-toolset'] },
};

/** Run Boundary's gateway methods against a recording client: the methods and keys they send. */
async function recordSessionCalls(): Promise<Call[]> {
  const calls: Call[] = [];
  const fake = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, keys: Object.keys(params) });
      return CANNED[method] ?? {};
    },
  };
  const session = new HermesGatewaySession();
  vi.spyOn(session, 'ensureConnected').mockResolvedValue(fake as unknown as JsonRpcGatewayClient);
  try {
    await session.replayPendingApprovals(['rec-session']);
    await session.respondPendingApproval({ sessionId: 's', approvalRequestId: 'r', choice: 'once', all: true });
    await session.ackApprovalReceived({ sessionId: 's', approvalRequestId: 'r' });
    await session.createSessionWithSeed({
      title: 'Contract title',
      messages: [{ role: 'user', content: 'Contract seed' }],
      profile: 'rec-profile',
      parentSessionId: 'rec-parent',
      historyBudget: DM_HISTORY_BUDGET,
    });
    await session.describeProfile('rec-profile');
    await session.createProfile({ name: 'rec-profile', description: 'd', soul: 's' });
    await session.configureProfile('rec-profile', { soul: 's', description: 'd' });
    await session.enableProfileToolsets('rec-other', ['rec-toolset'], 'rec-profile');
    await session.listSessions({ profile: 'rec-profile' });
    await session.resumeSession('rec-session', {
      historyBudget: DM_HISTORY_BUDGET,
      profile: 'rec-profile',
      omitMessages: true,
    });
    await session.getSessionHistory('rec-session');
    await session.listProjects();
    await session.setActiveProject('rec-project');
    await session.setSessionCwd('rec-session', '/rec');
    await session.setSessionTitle('rec-session', 'Contract title');
    await session.getDefaultCwd();
    await session.completePath({ word: '/', cwd: '/rec', sessionId: 'rec-session' });
    await session.getContextBreakdown('rec-session');
    await session.getMaxTurns('rec-profile');
    await session.applyToolsEnabled('rec-session', false);
    await session.submitPrompt('rec-session', 'Contract text', {
      truncate: { rowId: 1, confirmEmpty: true },
      displayKind: 'hidden',
      context: 'Contract context',
    });
    await session.getTurnLiveness();
    await session.getLiveStatus('rec-session', 'rec-profile');
  } finally {
    session.dispose();
  }
  return calls;
}

/**
 * Calls that pass through HermesGatewaySession unchanged, with the keys their callers send.
 * Update these with the named callers.
 */
const PASS_THROUGH_CALLS: Call[] = [
  // vendor/json-rpc-channel.ts: sent when gateway.ready arrives.
  { method: 'client.capabilities', keys: ['server_requests'] },
  // vendor/json-rpc-gateway.ts: event replay after a redial.
  { method: 'session.events.since', keys: ['session_id', 'last_seen'] },
  // HermesGatewaySession.cancelPrompt (returns early without an open socket, so not recorded).
  { method: 'session.interrupt', keys: ['session_id'] },
  // hermesVault.ts through requestVault; `profile` from its profileParams.
  { method: 'vault.list', keys: ['profile'] },
  { method: 'vault.sources', keys: ['profile'] },
  { method: 'vault.add', keys: ['profile', 'kind', 'label', 'origin', 'secret'] },
  { method: 'vault.remove', keys: ['profile', 'id'] },
  { method: 'vault.unlock', keys: ['profile', 'name', 'password'] },
  { method: 'vault.lock', keys: ['profile', 'name'] },
  // calendarService.ts through requestMcp.
  { method: 'reload.mcp', keys: ['confirm'] },
  { method: 'mcp.servers.status', keys: [] },
  { method: 'mcp.servers.remove', keys: ['profile', 'name'] },
];

/** Events Boundary subscribes to, with the payload fields it reads. */
const EVENTS_HANDLED: Array<{ name: string; fields: string[] }> = [
  // HermesGatewaySession constructor and openSocket.
  { name: 'sessions.changed', fields: [] },
  { name: 'request.cancel', fields: ['id'] },
  { name: 'gateway.ready', fields: [] },
  // runJsonRpcTurn (hermesChatSessions.ts), hermesRunningTurns.ts, hermesReplyEndings.ts.
  { name: 'message.delta', fields: ['text'] },
  { name: 'message.complete', fields: ['status', 'error', 'failure_reason'] },
  { name: 'session.usage', fields: ['usage'] },
  { name: 'turn.heartbeat', fields: [] },
  { name: 'tool.start', fields: ['tool_id', 'name', 'args'] },
  { name: 'tool.generating', fields: ['name'] },
  { name: 'tool.complete', fields: ['tool_id', 'name', 'args', 'duration_s', 'summary', 'result_text'] },
];

/** Server→client requests Boundary answers, with the params it reads. */
const SERVER_REQUESTS_HANDLED: Array<{ name: string; fields: string[] }> = [
  // parkApprovalRequest (hermesApprovals.ts).
  {
    name: 'approval',
    fields: [
      'session_id',
      'request_id',
      'command',
      'description',
      'tool_name',
      'choices',
      'allow_session',
      'allow_permanent',
      'smart_denied',
      'mcp',
    ],
  },
  // parkCredentialRequest (hermesCredentialRequests.ts).
  ...CREDENTIAL_REQUEST_KINDS.map((name) => ({
    name,
    fields: {
      secret: ['session_id', 'env_var', 'prompt'],
      'vault.unlock_prompt': ['session_id', 'backend', 'display_name'],
      'vault.save_login': ['session_id', 'origin', 'site'],
      'vault.code': ['session_id', 'site', 'hint'],
    }[name],
  })),
];

/**
 * Names the stack's overlays add to Hermes at runtime, so the registry in the image doesn't hold
 * them. Each has a live check below or through `gateway.capabilities`.
 */
const OVERLAY = {
  methods: ['session.live_status'], // gateway_liveness overlay
  params: {
    'session.create': ['history_budget'], // history_budget overlay
    'session.resume': ['history_budget'],
    'prompt.submit': ['context'], // client_context overlay
  } as Record<string, string[]>,
  events: ['turn.heartbeat'], // gateway_liveness overlay
  requestFields: { approval: ['mcp'] } as Record<string, string[]>, // mcp_trust_details overlay
  /** Answered by the WebSocket reader itself (tui_gateway/ws.py), not the method table. */
  transport: ['gateway.ping'],
};

/**
 * Differences between Boundary and the pinned Hermes that are known and not yet fixed. Each
 * entry is one problem string from the registry check; fixing the code makes the check fail
 * until the entry is removed.
 */
const KNOWN_MISMATCHES: string[] = [];

const REGISTRY_PROGRAM = (claims: unknown) => `
import json, sys
sys.path.insert(0, "/opt/hermes")
from tui_gateway.contracts import METHODS, EVENTS, SERVER_REQUESTS
claims = json.loads(${JSON.stringify(JSON.stringify(claims))})
problems = []
for c in claims["methods"]:
    contract = METHODS.get(c["method"])
    if contract is None:
        problems.append("method %s: not in the registry" % c["method"])
        continue
    fields = set(contract.params.model_fields)
    for key in c["keys"]:
        if key not in fields:
            problems.append("method %s: param %s not declared" % (c["method"], key))
for c in claims["events"]:
    contract = EVENTS.get(c["name"])
    if contract is None:
        problems.append("event %s: not in the registry" % c["name"])
        continue
    fields = set(contract.payload.model_fields) if contract.payload else set()
    for f in c["fields"]:
        if f not in fields:
            problems.append("event %s: field %s not declared" % (c["name"], f))
for c in claims["requests"]:
    contract = SERVER_REQUESTS.get(c["name"])
    if contract is None:
        problems.append("server request %s: not in the registry" % c["name"])
        continue
    fields = set(contract.params.model_fields)
    for f in c["fields"]:
        if f not in fields:
            problems.append("server request %s: field %s not declared" % (c["name"], f))
print(json.dumps(problems))
`;

/** Boundary's claims with the overlay names taken out, deduplicated per method. */
function claimsForRegistry(sessionCalls: Call[]) {
  const keysByMethod = new Map<string, Set<string>>();
  for (const { method, keys } of [...sessionCalls, ...PASS_THROUGH_CALLS]) {
    if (OVERLAY.methods.includes(method) || OVERLAY.transport.includes(method)) continue;
    const set = keysByMethod.get(method) ?? new Set<string>();
    for (const key of keys) if (!OVERLAY.params[method]?.includes(key)) set.add(key);
    keysByMethod.set(method, set);
  }
  return {
    methods: [...keysByMethod].map(([method, keys]) => ({ method, keys: [...keys].sort() })),
    events: EVENTS_HANDLED.filter((e) => !OVERLAY.events.includes(e.name)),
    requests: SERVER_REQUESTS_HANDLED.map((r) => ({
      name: r.name,
      fields: r.fields.filter((f) => !OVERLAY.requestFields[r.name]?.includes(f)),
    })),
  };
}

describe.skipIf(!probe.ok)(`Hermes gateway catalog${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;

  it('declares every method, param, event and server request Boundary uses', async () => {
    const sessionCalls = await recordSessionCalls();
    // The recorder reached every method above (a method that stopped early would drop out).
    expect(new Set(sessionCalls.map((c) => c.method)).size).toBeGreaterThanOrEqual(23);
    const problems = await pythonJsonInHermes<string[]>(
      target,
      REGISTRY_PROGRAM(claimsForRegistry(sessionCalls))
    );
    expect(problems.sort()).toEqual([...KNOWN_MISMATCHES].sort());
  });
});

describe.skipIf(!probe.ok)(`Hermes gateway over /api/ws${skipNote(probe)}`, () => {
  const target = (probe.ok ? probe.target : null) as StackTarget;
  const session = new HermesGatewaySession();
  let client: JsonRpcGatewayClient;
  let readyPayload: Record<string, unknown> | null = null;
  let sessionId = '';

  beforeAll(async () => {
    session.on('gateway.ready', (event) => {
      readyPayload = (event.payload as Record<string, unknown> | undefined) ?? {};
    });
    client = await session.ensureConnected();
    sessionId = await session.createSessionWithSeed({ historyBudget: DM_HISTORY_BUDGET });
  });

  afterAll(() => session.dispose());

  it('sends gateway.ready on connect and answers gateway.ping', async () => {
    expect(readyPayload).not.toBeNull();
    await expect(client.request('gateway.ping', {})).resolves.toMatchObject({ ok: true });
  });

  it('advertises the capabilities Boundary needs from the pinned stack', async () => {
    await expect(refuseLocalStackOlderThanPin(client, target.root)).resolves.toBeUndefined();
    const liveness = await session.getTurnLiveness();
    expect(liveness.heartbeatS).toBeGreaterThan(0);
  });

  it('creates and resumes a session with a history budget and reports its context', async () => {
    expect(sessionId).toBeTruthy();
    // Hermes resumes by the stored id; session.create returned the runtime id.
    const resumed = await session.resumeSession(session.storedSessionId(sessionId), {
      historyBudget: DM_HISTORY_BUDGET,
      omitMessages: true,
    });
    expect(resumed.sessionId).toBeTruthy();
    const raw = (await client.request('session.context_breakdown', { session_id: resumed.sessionId })) as Record<
      string,
      unknown
    >;
    expect(Array.isArray(raw.categories)).toBe(true);
    expect(typeof raw.context_max).toBe('number');
    expect(typeof raw.context_used).toBe('number');
    const breakdown = await session.getContextBreakdown(resumed.sessionId);
    expect(breakdown.history?.budget).toBe(DM_HISTORY_BUDGET);
  });

  it('answers session.live_status for one session', async () => {
    const raw = (await client.request('session.live_status', { session_id: sessionId })) as {
      status?: unknown;
    };
    expect(typeof raw.status).toBe('string');
  });

  it('lists toolsets and pending approvals for the session', async () => {
    const tools = (await client.request('tools.list', { session_id: sessionId })) as {
      toolsets?: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(tools.toolsets)).toBe(true);
    for (const t of tools.toolsets ?? []) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.enabled).toBe('boolean');
    }
    const pending = (await client.request('approval.pending', { session_id: sessionId })) as {
      approvals?: unknown;
    };
    expect(pending.approvals).toEqual([]);
  });

  it('answers the project, path and profile reads', async () => {
    await expect(session.getDefaultCwd()).resolves.toMatch(/^\//);
    const projects = (await client.request('projects.list', {})) as { projects?: unknown };
    expect(Array.isArray(projects.projects)).toBe(true);
    const completions = (await client.request('complete.path', {
      word: '/',
      cwd: null,
      session_id: sessionId,
    })) as { items?: unknown };
    expect(Array.isArray(completions.items)).toBe(true);
    // The built-in agent's call: the default profile.
    await expect(session.describeProfile('')).resolves.toHaveProperty('soul');
  });

  it('answers mcp.servers.status and vault.sources with the lists Boundary reads', async () => {
    const mcp = (await client.request('mcp.servers.status', {})) as { servers?: unknown };
    expect(Array.isArray(mcp.servers)).toBe(true);
    const vault = (await client.request('vault.sources', {})) as { sources?: unknown };
    expect(Array.isArray(vault.sources)).toBe(true);
  });
});
