import { broadcastSessionsChanged, emitHermesSessionsChanged } from './hermesSessionsChanged';
import { mintDashboardWsTicket } from './hermesDashboardAuth';
import {
  buildHermesWebSocketUrl,
  JsonRpcGatewayClient,
  type GatewayEvent,
} from './vendor';
import type { ServerRequest } from './vendor/json-rpc-channel';
import { isStableOpen, reconnectBackoffDelayMs } from './vendor/reconnect-backoff';
import { BrowserWindow } from 'electron';
import { broadcast } from '../../windows';
import type {
  HermesChatMessage,
  HermesChatThreadSummary,
  HermesCompletePathItem,
  HermesChatContextBreakdown,
  HermesHistoryWindow,
  HermesChatApprovalEvent,
  HermesChatCredentialRequestEvent,
} from '../../../../shared/types/hermesChat';
import {
  clearParkedApprovals,
  dropParkedApproval,
  parkApprovalRequest,
  REPLAYED_APPROVAL_PREFIX,
} from './hermesApprovals';
import { AssistantStackTooOldError, refuseLocalStackOlderThanPin } from './stackPinCheck';
import { listRunningTurns } from './hermesRunningTurns';
import { getStoredSessionAlias, setStoredSessionAlias } from './hermesAgentStore';
import { stackMode } from '../localStackMode';
import {
  clearParkedCredentialRequests,
  dropParkedCredentialRequest,
  isCredentialRequestKind,
  parkCredentialRequest,
  respondToCredentialRequest,
} from './hermesCredentialRequests';
import type { ParkedResponder } from './parkedRequests';
import { toUnixSeconds } from '../../../../shared/messageTime';
import { uniquePreserveOrder, writtenPathsOf } from '../../../../shared/hermesToolPaths';
import { filedTaskOf } from '../../../../shared/hermesKanbanFiled';
import type { KanbanFiledTask } from '../../../../shared/types/hermesKanban';

/** Source tag for sessions minted by Boundary's in-app chat. */
export const BOUNDARY_SESSION_SOURCE = 'boundary';

type EventHandler = (event: GatewayEvent) => void;
type ApprovalNotifier = (event: HermesChatApprovalEvent) => void;
/** Returns false when no renderer could be asked. */
type CredentialRequestNotifier = (event: HermesChatCredentialRequestEvent) => boolean;

/** Keeps runtime → stored session ids across restarts, so a runtime id still resolves later. */
export interface StoredIdArchive {
  get(runtimeId: string): string | null;
  set(runtimeId: string, storedId: string): void;
}

type TranscriptRow = {
  role?: string;
  text?: string | null;
  content?: string | null;
  timestamp?: number | null;
  row_id?: number | null;
  /** Tool rows: the tool name and its full args. */
  name?: string | null;
  args?: Record<string, unknown> | null;
  /** `hidden` rows are off-screen sends (Continue) that no client renders. */
  display_kind?: string | null;
};

/**
 * Gateway transcript rows → chat messages, keeping the stored time and durable row id.
 * Tool rows are not messages, but the files their write tools touched are attached to
 * the turn's next assistant reply (the Files line under a reply, spec Phase 4), and so are
 * the kanban tasks it filed (task cards, docs/kanban-activity-ux-study Phase 2).
 */
export function mapTranscriptMessages(messages: TranscriptRow[]): HermesChatMessage[] {
  // Tools a turn ran, counted over the whole turn: an assistant row's own tool calls are
  // stored after its text, and one turn can hold several assistant rows.
  const toolsInTurn: number[] = [0];
  let turn = 0;
  const turnOf = messages.map((m) => {
    if (m.role === 'user') {
      turn += 1;
      toolsInTurn[turn] = 0;
    } else if (m.role === 'tool') {
      toolsInTurn[turn] += 1;
    }
    return turn;
  });

  let pendingFiles: string[] = [];
  let pendingTasks: KanbanFiledTask[] = [];
  // Tasks filed after a turn's last reply text go on that reply rather than being lost.
  let turnReply: HermesChatMessage | null = null;
  const settleTasks = () => {
    if (pendingTasks.length > 0 && turnReply) {
      turnReply.tasksFiled = [...(turnReply.tasksFiled ?? []), ...pendingTasks];
    }
    pendingTasks = [];
  };
  const mapped = messages
    .map((m, index) => {
      if (m.role === 'tool') {
        pendingFiles.push(...writtenPathsOf(m.name, m.args));
        const filed = filedTaskOf(m.name, m.args);
        if (filed) pendingTasks.push(filed);
        return null;
      }
      if (m.display_kind === 'hidden') return null;
      if (m.role === 'user') {
        pendingFiles = [];
        settleTasks();
        turnReply = null;
      }
      const role =
        m.role === 'assistant' || m.role === 'system' || m.role === 'user'
          ? m.role
          : null;
      const content =
        typeof m.text === 'string'
          ? m.text
          : typeof m.content === 'string'
            ? m.content
            : '';
      if (!role || !content) return null;
      const out: HermesChatMessage = { role, content };
      if (role === 'assistant' && pendingFiles.length > 0) {
        out.files = uniquePreserveOrder(pendingFiles);
        pendingFiles = [];
      }
      if (role === 'assistant' && pendingTasks.length > 0) {
        out.tasksFiled = pendingTasks;
        pendingTasks = [];
      }
      if (role === 'assistant') {
        out.toolCount = toolsInTurn[turnOf[index]];
        turnReply = out;
      }
      const timestamp = toUnixSeconds(m.timestamp);
      if (timestamp != null) out.timestamp = timestamp;
      if (typeof m.row_id === 'number' && Number.isFinite(m.row_id)) out.rowId = m.row_id;
      return out;
    })
    .filter((m): m is HermesChatMessage => m != null);
  settleTasks();
  return mapped;
}

export type HermesVaultMethod =
  | 'vault.list'
  | 'vault.sources'
  | 'vault.add'
  | 'vault.remove'
  | 'vault.unlock'
  | 'vault.lock';

/** MCP calls Boundary makes for the servers it writes into profiles (calendars). */
export type HermesMcpMethod = 'reload.mcp' | 'mcp.servers.status' | 'mcp.servers.remove';

/**
 * Main-process JSON-RPC client over the Hermes dashboard WebSocket.
 * Uses the vendored MIT JsonRpcGatewayClient from hermes-agent.
 */
export interface TurnLiveness {
  /** Seconds between `turn.heartbeat` events while a turn runs; null when none are sent. */
  heartbeatS: number | null;
}

/**
 * Where the gateway connection stands. `reconnecting`: an open connection dropped and the
 * session is redialing it. `refused`: the local stack is older than the pin (decision D2), so
 * nothing redials until a caller asks again.
 */
export type GatewayConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'refused'
  | 'disposed';

/** Why an answer to a parked request could not be sent. */
const GATEWAY_DROPPED_MESSAGE =
  'The connection to the assistant stack dropped, so that answer was not sent. Hermes asks again once it reconnects.';

/**
 * Owns the one connection to the Hermes gateway. It keeps a single vendored client for its
 * whole life and redials that client when its socket drops, with the vendored backoff. The
 * client keeps its event subscribers and per-session seq watermarks across sockets, so a turn
 * listening through `on()` gets the events it missed replayed (`session.events.since`) once
 * the socket is back. Server requests asked on a socket that dropped are cleared with it.
 */
export class HermesGatewaySession {
  private readonly client = new JsonRpcGatewayClient({
    requestIdPrefix: 'b',
    requestTimeoutMs: 180_000,
  });
  private state: GatewayConnectionState = 'idle';
  private dialing: Promise<void> | null = null;
  private redialTimer: ReturnType<typeof setTimeout> | null = null;
  private redialAttempt = 0;
  private openedAt: number | null = null;
  /** Sessions whose parked requests a dropped socket cleared: their approvals are asked for again. */
  private readonly replaySessions = new Set<string>();
  /**
   * Runtime session id → stored (state.db) id. The gateway hands out a runtime id on
   * create / resume; anything that writes lineage (`parent_session_id`) needs the stored
   * one, or the row fails its foreign key and the branch is never saved.
   */
  private storedIds = new Map<string, string>();
  private storedIdArchive: StoredIdArchive | null = null;
  private approvalNotifier: ApprovalNotifier | null = null;
  private credentialRequestNotifier: CredentialRequestNotifier | null = null;
  // This connection's `gateway.capabilities`, asked once per connection ({} when unanswered).
  private capabilities: Promise<Record<string, unknown>> | null = null;

  constructor() {
    // Attached once: the client keeps them across every socket it opens.
    this.client.onRequest((request) => this.handleServerRequest(request));
    this.client.on('sessions.changed', () => {
      emitHermesSessionsChanged();
      broadcastSessionsChanged();
    });
    this.client.on('request.cancel' as never, (event: GatewayEvent) => {
      const id = (event.payload as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string') return;
      dropParkedApproval(id);
      dropParkedCredentialRequest(id);
    });
    this.client.onState((clientState) => {
      if (clientState === 'closed') this.onSocketClosed();
    });
  }

  get connectionState(): GatewayConnectionState {
    return this.state;
  }

  setApprovalNotifier(notifier: ApprovalNotifier | null): void {
    this.approvalNotifier = notifier;
  }

  setCredentialRequestNotifier(notifier: CredentialRequestNotifier | null): void {
    this.credentialRequestNotifier = notifier;
  }

  setStoredIdArchive(archive: StoredIdArchive | null): void {
    this.storedIdArchive = archive;
  }

  private linkStored(runtimeId: string, storedId: string): void {
    this.storedIds.set(runtimeId, storedId);
    if (runtimeId !== storedId) this.storedIdArchive?.set(runtimeId, storedId);
  }

  private isOpen(): boolean {
    return this.state === 'open' && this.client.connectionState === 'open';
  }

  async ensureConnected(): Promise<JsonRpcGatewayClient> {
    if (this.state === 'disposed') throw new Error('Hermes gateway session was disposed');
    if (this.isOpen()) return this.client;
    // A caller waiting on the connection dials now rather than after the backoff.
    this.cancelRedial();
    await this.dial();
    if (!this.isOpen()) {
      throw new Error('Hermes gateway failed to connect');
    }
    return this.client;
  }

  /** One dial at a time; every caller waits on the same one. */
  private dial(): Promise<void> {
    if (this.dialing) return this.dialing;
    const redialing = this.state === 'reconnecting';
    if (!redialing) this.state = 'connecting';
    this.dialing = this.openSocket()
      .then(
        () => {
          this.state = 'open';
          this.openedAt = Date.now();
          this.capabilities = null;
          void this.replayPendingApprovals(this.sessionsToReplay()).catch((): void => undefined);
        },
        (err: unknown) => {
          if (this.state === 'disposed') throw err;
          if (err instanceof AssistantStackTooOldError) {
            this.state = 'refused';
          } else if (redialing) {
            this.scheduleRedial();
          } else {
            this.state = 'idle';
          }
          throw err;
        }
      )
      .finally(() => {
        this.dialing = null;
      });
    return this.dialing;
  }

  private async openSocket(): Promise<void> {
    const { ticket, dashboardBaseUrl } = await mintDashboardWsTicket();
    const parsed = new URL(dashboardBaseUrl);
    const wsUrl = buildHermesWebSocketUrl({
      protocol: parsed.protocol,
      host: parsed.host,
      path: '/api/ws',
      authParam: ['ticket', ticket],
    });
    if (this.state === 'disposed') throw new Error('Hermes gateway session was disposed');

    // Wait for gateway.ready (or go on after 3s), and stop waiting if the socket closes.
    // Subscribed before the socket opens, so a ready that arrives at once isn't missed.
    let settle: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timeout = setTimeout(settle, 3_000);
    const unsubReady = this.client.on('gateway.ready' as never, () => settle());
    try {
      await this.client.connect(wsUrl);
      const unsubState = this.client.onState((clientState) => {
        if (clientState !== 'open') settle();
      });
      // The vendored channel advertises `client.capabilities` itself when it sees gateway.ready.
      await ready;
      unsubState();
    } finally {
      clearTimeout(timeout);
      unsubReady();
    }

    const mode = stackMode();
    if (mode.kind === 'local') await refuseLocalStackOlderThanPin(this.client, mode.root);
    // A socket that closed while waiting for gateway.ready is a failed dial, not an open one.
    if (this.client.connectionState !== 'open') throw new Error('Hermes gateway closed while connecting');
  }

  /** The open socket dropped: requests it asked are gone with it, and the session redials. */
  private onSocketClosed(): void {
    for (const event of [...clearParkedApprovals(), ...clearParkedCredentialRequests()]) {
      this.replaySessions.add(event.sessionId);
    }
    if (this.state !== 'open') return;
    this.state = 'reconnecting';
    if (isStableOpen(this.openedAt)) this.redialAttempt = 0;
    this.openedAt = null;
    this.scheduleRedial();
  }

  private scheduleRedial(): void {
    if (this.redialTimer || this.state !== 'reconnecting') return;
    const delay = reconnectBackoffDelayMs(this.redialAttempt);
    this.redialAttempt += 1;
    this.redialTimer = setTimeout(() => {
      this.redialTimer = null;
      void this.dial().catch((): void => undefined);
    }, delay);
  }

  private cancelRedial(): void {
    if (this.redialTimer) clearTimeout(this.redialTimer);
    this.redialTimer = null;
  }

  /** Answers over the socket that asked, and throws when that socket is gone. */
  private responderFor(request: ServerRequest): ParkedResponder {
    return (result) => {
      if (this.client.connectionState !== 'open') throw new Error(GATEWAY_DROPPED_MESSAGE);
      request.respond(result);
    };
  }

  private handleServerRequest(request: ServerRequest): boolean {
    if (isCredentialRequestKind(request.method)) {
      const credentialEvent = parkCredentialRequest(request, this.responderFor(request));
      // A request Boundary can't show: answer "skipped" now rather than leave Hermes waiting.
      if (!credentialEvent) {
        request.respond({ value: '' });
        return true;
      }
      if (!this.credentialRequestNotifier?.(credentialEvent)) {
        void respondToCredentialRequest({ rpcRequestId: credentialEvent.rpcRequestId });
      }
      return true;
    }
    if (request.method !== 'approval') {
      return false;
    }
    const event = parkApprovalRequest(request, this.responderFor(request));
    if (!event) {
      request.fail(-32603, 'invalid approval request');
      return true;
    }
    this.approvalNotifier?.(event);
    return true;
  }

  /** Sessions to ask `approval.pending` for: those whose requests a drop cleared, and running turns'. */
  private sessionsToReplay(): string[] {
    const ids = new Set(this.replaySessions);
    this.replaySessions.clear();
    for (const turn of listRunningTurns()) for (const id of turn.sessionIds) ids.add(id);
    return [...ids];
  }

  /**
   * Ask Hermes for approvals still waiting in its queue for these sessions and park them,
   * answered with `approval.respond`. An approval already parked live is kept as it is.
   */
  async replayPendingApprovals(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const client = await this.ensureConnected();
    await Promise.all(
      sessionIds.map(async (askedId) => {
        let rows: Array<Record<string, unknown>>;
        try {
          const result = (await client.request('approval.pending', { session_id: askedId })) as {
            approvals?: Array<Record<string, unknown>>;
          };
          rows = result.approvals ?? [];
        } catch {
          return;
        }
        for (const row of rows) this.parkReplayedApproval(row, askedId);
      })
    );
  }

  private parkReplayedApproval(row: Record<string, unknown>, askedId: string): void {
    const requestId = typeof row.request_id === 'string' ? row.request_id : null;
    if (!requestId) return;
    const sessionId = typeof row.session_id === 'string' && row.session_id ? row.session_id : askedId;
    const synthetic: ServerRequest = {
      id: `${REPLAYED_APPROVAL_PREFIX}${requestId}`,
      method: 'approval',
      params: {
        session_id: sessionId,
        request_id: requestId,
        command: typeof row.command === 'string' ? row.command : undefined,
        description: typeof row.description === 'string' ? row.description : undefined,
        tool_name: typeof row.tool_name === 'string' ? row.tool_name : undefined,
        choices: row.choices as never,
        allow_session: row.allow_session as never,
        allow_permanent: row.allow_permanent as never,
        smart_denied: row.smart_denied as never,
        mcp: row.mcp as never,
      },
      replayed: true,
      respond: () => undefined,
      fail: () => undefined,
    };
    const event = parkApprovalRequest(synthetic, (result) =>
      this.respondPendingApproval({
        sessionId,
        approvalRequestId: requestId,
        choice: String(result.choice),
        all: result.all === true,
      })
    );
    if (event?.rpcRequestId === synthetic.id) this.approvalNotifier?.(event);
  }

  async respondPendingApproval(opts: {
    sessionId: string;
    approvalRequestId: string;
    choice: string;
    all?: boolean;
  }): Promise<void> {
    const client = await this.ensureConnected();
    await client.request('approval.respond', {
      session_id: opts.sessionId,
      request_id: opts.approvalRequestId,
      choice: opts.choice,
      ...(opts.all ? { all: true } : {}),
    });
  }

  async ackApprovalReceived(opts: {
    sessionId: string;
    approvalRequestId: string;
  }): Promise<void> {
    const client = await this.ensureConnected();
    await client.request('approval.received', {
      session_id: opts.sessionId,
      request_id: opts.approvalRequestId,
    });
  }

  async createSessionWithSeed(opts?: {
    title?: string;
    messages?: HermesChatMessage[];
    /** Named Hermes profile; omit for the default / built-in Assistant. */
    profile?: string | null;
    /** Lineage for a branched chat (`parent_session_id`). */
    parentSessionId?: string;
    /** History budget in tokens (CR 0002 R1); DMs only. */
    historyBudget?: number;
  }): Promise<string> {
    const client = await this.ensureConnected();
    const params: Record<string, unknown> = {
      source: BOUNDARY_SESSION_SOURCE,
    };
    if (opts?.historyBudget != null) {
      params.history_budget = opts.historyBudget;
    }
    if (opts?.title?.trim()) {
      params.title = opts.title.trim();
    }
    if (opts?.profile?.trim()) {
      params.profile = opts.profile.trim();
    }
    if (opts?.parentSessionId) {
      params.parent_session_id = opts.parentSessionId;
    }
    if (opts?.messages && opts.messages.length > 0) {
      params.messages = opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
        text: m.content,
      }));
    }
    const result = (await client.request('session.create', params)) as {
      session_id?: string;
      id?: string;
      stored_session_id?: string | null;
    };
    const id = result.session_id ?? result.id;
    if (!id) {
      throw new Error('session.create returned no session id');
    }
    if (result.stored_session_id) this.linkStored(id, result.stored_session_id);
    return id;
  }

  /** The stored id for a runtime id this client (or an earlier run) created or resumed; otherwise the id itself. */
  storedSessionId(sessionId: string): string {
    return this.storedIds.get(sessionId) ?? this.storedIdArchive?.get(sessionId) ?? sessionId;
  }

  /** The latest runtime id this connection opened for a stored id, if any. */
  runtimeSessionId(storedId: string): string | null {
    let latest: string | null = null;
    for (const [runtimeId, stored] of this.storedIds) {
      if (stored === storedId) latest = runtimeId;
    }
    return latest;
  }

  /** `name` empty describes the default profile, which Hermes names `default` (it refuses no name). */
  async describeProfile(name: string): Promise<{ soul?: string | null }> {
    const client = await this.ensureConnected();
    return (await client.request('profiles.describe', { name: name.trim() || 'default' })) as {
      soul?: string | null;
    };
  }

  /** Create an independent Hermes profile (name + role/soul). */
  async createProfile(opts: {
    name: string;
    description?: string;
    soul?: string;
    mirrorCredentials?: boolean;
  }): Promise<void> {
    const client = await this.ensureConnected();
    await client.request('profiles.create', {
      name: opts.name,
      description: opts.description ?? null,
      soul: opts.soul ?? null,
      mirror_credentials: opts.mirrorCredentials !== false,
      // Calendar passwords stay with the agents given access (stack v0.3.3+, calendar spec).
      mirror_exclude: ['BOUNDARY_CALENDAR_*'],
      clone_from: null,
    });
  }

  /** Update a profile's soul and/or description; Hermes reports each section it applied. */
  async configureProfile(
    name: string,
    sections: { soul?: string; description?: string }
  ): Promise<{ ok: boolean }> {
    const client = await this.ensureConnected();
    const result = (await client.request('profiles.configure', { name, ...sections })) as {
      ok?: boolean;
    };
    return { ok: result.ok !== false };
  }

  /**
   * Turn toolsets on in the profile that owns a session (Hermes saves them in that profile's
   * `platform_toolsets.cli`). Hermes scopes the change to the profile only for a live session,
   * so a stored one is resumed (from `profile`) first. True when every name came back enabled.
   */
  async enableProfileToolsets(
    sessionId: string,
    names: string[],
    profile?: string | null
  ): Promise<boolean> {
    const client = await this.ensureConnected();
    const result = (await this.withLiveSession(
      sessionId,
      (id) => client.request('tools.configure', { action: 'enable', names, session_id: id }),
      profile
    )) as { enabled_toolsets?: string[] };
    const enabled = new Set(result.enabled_toolsets ?? []);
    return names.every((name) => enabled.has(name));
  }

  /** Vault RPCs (tui_gateway/methods_vault.py). Params may carry a secret: never log them. */
  async requestVault(method: HermesVaultMethod, params: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    return client.request(method, params);
  }

  /** MCP server calls. Params name servers and profiles only, never secrets. */
  async requestMcp(method: HermesMcpMethod, params: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected();
    return client.request(method, params);
  }

  /** Stored sessions, newest first; `profile` lists an agent profile's own db instead. */
  async listSessions(opts?: { profile?: string | null }): Promise<HermesChatThreadSummary[]> {
    const client = await this.ensureConnected();
    const result = (await client.request('session.list', {
      limit: 100,
      ...(opts?.profile?.trim() ? { profile: opts.profile.trim() } : {}),
    })) as {
      sessions?: Array<{
        id?: string;
        resolved_id?: string | null;
        title?: string;
        preview?: string;
        started_at?: number;
        last_active?: number;
        source?: string;
        cwd?: string | null;
      }>;
    };
    const sessions = result.sessions ?? [];
    return sessions
      .map((s) => {
        const id = String(s.resolved_id || s.id || '');
        const activity =
          typeof s.last_active === 'number'
            ? s.last_active
            : typeof s.started_at === 'number'
              ? s.started_at
              : null;
        return {
          id,
          title: String(s.title || s.preview || 'Chat'),
          source:
            typeof s.source === 'string' && s.source.trim()
              ? s.source.trim()
              : undefined,
          updatedAt:
            activity != null ? new Date(activity * 1000).toISOString() : undefined,
          createdAt:
            typeof s.started_at === 'number'
              ? new Date(s.started_at * 1000).toISOString()
              : undefined,
          ...(typeof s.cwd === 'string' && s.cwd.trim() ? { cwd: s.cwd.trim() } : {}),
        };
      })
      .filter((s) => s.id);
  }

  /**
   * Attach to a stored session (WebUI / cold gateway rows). Prefer resume
   * messages when present; fall back to session.history.
   */
  async resumeSession(
    sessionId: string,
    opts?: {
      /** History budget in tokens (CR 0002 R1). Omitted keeps the session's stored one. */
      historyBudget?: number;
      /** The agent profile that stores the session; Hermes only finds it in that profile's db. */
      profile?: string | null;
      /** Skip the transcript (`omit_messages`) when the caller only needs the live session. */
      omitMessages?: boolean;
    }
  ): Promise<{
    sessionId: string;
    messages: HermesChatMessage[];
  }> {
    const client = await this.ensureConnected();
    const params: Record<string, unknown> = {
      session_id: sessionId,
      source: BOUNDARY_SESSION_SOURCE,
    };
    if (opts?.historyBudget != null) params.history_budget = opts.historyBudget;
    if (opts?.profile?.trim()) params.profile = opts.profile.trim();
    if (opts?.omitMessages) params.omit_messages = true;
    const result = (await client.request('session.resume', params)) as {
      session_id?: string;
      stored_session_id?: string | null;
      messages?: TranscriptRow[];
      messages_omitted?: boolean | null;
    };
    const runtimeId = result.session_id ?? sessionId;
    this.linkStored(runtimeId, result.stored_session_id || sessionId);
    const messages =
      result.messages_omitted === true
        ? []
        : mapTranscriptMessages(result.messages ?? []);
    return { sessionId: runtimeId, messages };
  }

  async getSessionHistory(sessionId: string): Promise<HermesChatMessage[]> {
    const client = await this.ensureConnected();
    const result = (await client.request('session.history', {
      session_id: sessionId,
    })) as {
      messages?: TranscriptRow[];
    };
    return mapTranscriptMessages(result.messages ?? []);
  }

  async listProjects(): Promise<{
    projects: Array<{
      id: string;
      slug: string;
      name: string;
      primaryPath?: string | null;
      archived?: boolean;
    }>;
    activeId: string | null;
  }> {
    const client = await this.ensureConnected();
    const result = (await client.request('projects.list', {})) as {
      projects?: Array<{
        id?: string;
        slug?: string;
        name?: string;
        primary_path?: string | null;
        archived?: boolean;
      }>;
      active_id?: string | null;
    };
    const projects = (result.projects ?? [])
      .filter((p) => p?.id && p.slug)
      .map((p) => ({
        id: String(p.id),
        slug: String(p.slug),
        name: String(p.name ?? p.slug),
        primaryPath: p.primary_path ?? null,
        archived: Boolean(p.archived),
      }));
    return {
      projects,
      activeId: result.active_id ?? null,
    };
  }

  async setActiveProject(id: string | null): Promise<void> {
    const client = await this.ensureConnected();
    await client.request('projects.set_active', { id });
  }

  async setSessionCwd(sessionId: string, cwd: string): Promise<void> {
    const client = await this.ensureConnected();
    await client.request('session.cwd.set', {
      session_id: sessionId,
      cwd,
    });
  }

  /**
   * Renames a session. Hermes only titles a live session, so a stored id without a live one
   * on this connection is resumed first, without making it the current session.
   */
  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    const client = await this.ensureConnected();
    await this.withLiveSession(sessionId, (id) =>
      client.request('session.title', { session_id: id, title })
    );
  }

  /**
   * Runs a session-scoped request against the live runtime for a session, resuming the stored
   * session first (without making it the current one) when this connection has no live one.
   */
  private async withLiveSession<T>(
    sessionId: string,
    run: (id: string) => Promise<T>,
    profile?: string | null
  ): Promise<T> {
    const client = await this.ensureConnected();
    const live =
      this.runtimeSessionId(sessionId) ?? (this.storedIds.has(sessionId) ? sessionId : null);
    if (live) {
      try {
        return await run(live);
      } catch {
        // The runtime id may have died with a Hermes restart; resume the stored one.
      }
    }
    const stored = this.storedSessionId(sessionId);
    const resumed = (await client.request('session.resume', {
      session_id: stored,
      source: BOUNDARY_SESSION_SOURCE,
      omit_messages: true,
      ...(profile?.trim() ? { profile: profile.trim() } : {}),
    })) as { session_id?: string; stored_session_id?: string | null };
    const runtimeId = resumed.session_id ?? stored;
    this.linkStored(runtimeId, resumed.stored_session_id || stored);
    return run(runtimeId);
  }

  /** The folder a session works in when it has no project (ADR 0024 §2). */
  async getDefaultCwd(): Promise<string> {
    const client = await this.ensureConnected();
    const result = (await client.request('projects.for_cwd', {})) as { cwd?: string };
    const cwd = typeof result.cwd === 'string' ? result.cwd.trim() : '';
    if (!cwd) throw new Error('projects.for_cwd returned no cwd');
    return cwd;
  }

  async completePath(params: {
    word?: string;
    cwd?: string;
    sessionId?: string;
  }): Promise<HermesCompletePathItem[]> {
    const client = await this.ensureConnected();
    const result = (await client.request('complete.path', {
      word: params.word ?? null,
      cwd: params.cwd ?? null,
      session_id: params.sessionId ?? null,
    })) as {
      items?: Array<{ text?: string; display?: string; meta?: string }>;
    };
    return (result.items ?? [])
      .map((item) => ({
        text: String(item.text ?? ''),
        display: item.display,
        meta: item.meta,
      }))
      .filter((item) => item.text);
  }

  async getContextBreakdown(sessionId: string): Promise<HermesChatContextBreakdown> {
    const client = await this.ensureConnected();
    const result = (await client.request('session.context_breakdown', {
      session_id: sessionId,
    })) as {
      categories?: Array<{ id?: string; label?: string; tokens?: number; color?: string }>;
      context_used?: number;
      context_max?: number;
      context_percent?: number;
      context_estimated?: boolean;
      model?: string;
      history_budget?: number | null;
      history_tokens?: number | null;
      history_first_row_id?: number | null;
      history_summarised?: boolean | null;
      context_files?: Array<{
        label?: string;
        path?: string;
        chars?: number;
        est_tokens?: number;
        loaded?: boolean;
        status?: string;
      }>;
    };
    return {
      categories: (result.categories ?? []).map((c) => ({
        id: String(c.id ?? ''),
        label: String(c.label ?? c.id ?? ''),
        tokens: Number(c.tokens ?? 0),
        color: c.color,
      })),
      contextUsed: Number(result.context_used ?? 0),
      contextMax: Number(result.context_max ?? 0),
      contextPercent: Number(result.context_percent ?? 0),
      contextEstimated: Boolean(result.context_estimated),
      model: result.model,
      contextFiles: (result.context_files ?? []).map((f) => ({
        label: String(f.label ?? ''),
        path: String(f.path ?? ''),
        chars: Number(f.chars ?? 0),
        estTokens: Number(f.est_tokens ?? 0),
        loaded: Boolean(f.loaded),
        status: String(f.status ?? ''),
      })),
      ...('history_budget' in result ? { history: mapHistoryWindow(result) } : {}),
    };
  }

  /**
   * Read agent.max_turns from config when available. Callers should treat
   * null as unknown rather than hardcoding a default.
   */
  /**
   * The profile's configured turn limit, read the way Hermes does (`agent.max_turns`, then a
   * top-level `max_turns`). Null when unset, unlimited (0 or a word) or unreadable: Hermes has no
   * getter for the key alone, so this reads the whole config.
   */
  async getMaxTurns(profile?: string | null): Promise<number | null> {
    const client = await this.ensureConnected();
    try {
      const result = (await client.request('config.get', {
        key: 'full',
        ...(profile?.trim() ? { profile: profile.trim() } : {}),
      })) as { config?: { agent?: { max_turns?: unknown } | null; max_turns?: unknown } | null };
      const value = result.config?.agent?.max_turns ?? result.config?.max_turns;
      // Hermes truncates to an int, and treats 0 or less as unlimited.
      const n = Math.trunc(
        typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
      );
      if (Number.isFinite(n) && n > 0) return n;
    } catch {
      /* optional */
    }
    return null;
  }

  /**
   * When toolsEnabled is false, disable all currently-enabled toolsets for the
   * session. When true, re-enable previously disabled toolsets if we have them.
   */
  async applyToolsEnabled(sessionId: string, toolsEnabled: boolean): Promise<void> {
    const client = await this.ensureConnected();
    try {
      const listed = (await client.request('tools.list', {
        session_id: sessionId,
      })) as { toolsets?: Array<{ name?: string; enabled?: boolean }> };
      const toolsets = listed.toolsets ?? [];
      if (toolsEnabled) {
        const disabled = toolsets
          .filter((t) => t.name && t.enabled === false)
          .map((t) => String(t.name));
        const toEnable = disabledToolsetsBySession.get(sessionId) ?? [];
        const names = toEnable.filter((n) => disabled.includes(n));
        if (names.length > 0) {
          await client.request('tools.configure', {
            action: 'enable',
            names,
            session_id: sessionId,
          });
          disabledToolsetsBySession.delete(sessionId);
        }
        return;
      }
      const enabled = toolsets
        .filter((t) => t.name && t.enabled !== false)
        .map((t) => String(t.name));
      if (enabled.length === 0) return;
      disabledToolsetsBySession.set(sessionId, enabled);
      await client.request('tools.configure', {
        action: 'disable',
        names: enabled,
        session_id: sessionId,
      });
    } catch {
      /* gateway may not support tools.configure — leave lever as UI-only then */
    }
  }

  /** Subscribe to a gateway event. Works before the first connection and across redials. */
  on(event: string, handler: EventHandler): () => void {
    return this.client.on(event as never, handler);
  }

  /**
   * No `profile`: a turn always runs on the profile that owns the session. Hermes ignored a
   * different one, and from stack v0.3.3 refuses it (`4081`), so sending it gains nothing.
   */
  async submitPrompt(
    sessionId: string,
    text: string,
    opts?: {
      /** Replace history from this durable user row onward (edit / retry). */
      truncate?: { rowId: number; confirmEmpty: boolean };
      /** `hidden`: Hermes stores the row typed so no client renders it (Continue). */
      displayKind?: 'hidden';
      /** Turn context: added to this turn's model input, never to `session.history`. */
      context?: string;
    }
  ): Promise<void> {
    const client = await this.ensureConnected();
    const params: Record<string, unknown> = {
      session_id: sessionId,
      text,
    };
    if (opts?.displayKind) {
      params.display_kind = opts.displayKind;
    }
    if (opts?.context) {
      params.context = opts.context;
    }
    if (opts?.truncate) {
      params.truncate_before_row_id = opts.truncate.rowId;
      params.confirm_truncate = true;
      if (opts.truncate.confirmEmpty) params.confirm_empty_truncate = true;
    }
    await client.request('prompt.submit', params);
  }

  private async getCapabilities(): Promise<Record<string, unknown>> {
    const client = await this.ensureConnected();
    this.capabilities ??= client
      .request('gateway.capabilities', {})
      .then((caps) => (caps && typeof caps === 'object' ? (caps as Record<string, unknown>) : {}))
      .catch(() => ({}));
    return this.capabilities;
  }

  /** How often the gateway sends `turn.heartbeat` while a turn runs (stack v0.3.3+). */
  async getTurnLiveness(): Promise<TurnLiveness> {
    const caps = await this.getCapabilities();
    const every = Number(caps.turn_heartbeat_s);
    return {
      heartbeatS: caps.turn_heartbeat === true && Number.isFinite(every) && every > 0 ? every : null,
    };
  }

  /**
   * Where Hermes says a session stands ('working', 'waiting', 'idle', …), or null when it
   * is not live. Throws when the gateway cannot answer.
   */
  async getLiveStatus(sessionId: string, profile?: string | null): Promise<string | null> {
    const client = await this.ensureConnected();
    const result = (await client.request('session.live_status', {
      ...(profile?.trim() ? { profile: profile.trim() } : {}),
      session_id: sessionId,
    })) as { status?: string; running?: boolean };
    return result.status ?? (result.running ? 'working' : 'idle');
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    if (!this.isOpen()) return;
    try {
      await this.client.request('session.interrupt', { session_id: sessionId });
    } catch {
      /* best-effort */
    }
  }

  dispose(): void {
    this.state = 'disposed';
    this.cancelRedial();
    this.approvalNotifier = null;
    this.credentialRequestNotifier = null;
    this.client.close();
    clearParkedApprovals();
    clearParkedCredentialRequests();
  }
}

const disabledToolsetsBySession = new Map<string, string[]>();

let sharedGateway: HermesGatewaySession | null = null;

/**
 * The app's one gateway session. Prompts go to every window (each shows only its open chat's),
 * and the stored-id archive is attached before anything connects, so both work from the first
 * chat list, not only after the first send.
 */
export function getHermesGatewaySession(): HermesGatewaySession {
  if (!sharedGateway) {
    sharedGateway = new HermesGatewaySession();
    sharedGateway.setStoredIdArchive({ get: getStoredSessionAlias, set: setStoredSessionAlias });
    sharedGateway.setApprovalNotifier((event) => broadcast('hermes-chat:approval', event));
    sharedGateway.setCredentialRequestNotifier((event) => {
      if (!BrowserWindow.getAllWindows().some((win) => !win.isDestroyed())) return false;
      broadcast('hermes-chat:credential-request', event);
      return true;
    });
  }
  return sharedGateway;
}

/** Test helper — reset the singleton between unit tests. */
export function resetHermesGatewaySessionForTests(): void {
  sharedGateway?.dispose();
  sharedGateway = null;
  disabledToolsetsBySession.clear();
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The stack's history cut fields (CR 0002 R2), as reported. */
export function mapHistoryWindow(result: {
  history_budget?: number | null;
  history_tokens?: number | null;
  history_first_row_id?: number | null;
  history_summarised?: boolean | null;
}): HermesHistoryWindow {
  return {
    budget: finiteOrNull(result.history_budget),
    tokens: finiteOrNull(result.history_tokens),
    firstRowId: finiteOrNull(result.history_first_row_id),
    summarised: result.history_summarised === true,
  };
}
