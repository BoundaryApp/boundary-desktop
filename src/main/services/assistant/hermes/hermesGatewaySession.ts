import { broadcastSessionsChanged, emitHermesSessionsChanged } from './hermesSessionsChanged';
import { mintDashboardWsTicket } from './hermesDashboardAuth';
import {
  buildHermesWebSocketUrl,
  JsonRpcGatewayClient,
  type GatewayEvent,
} from './vendor';
import { JsonRpcGatewayError, type ServerRequest } from './vendor/json-rpc-channel';
import type {
  HermesChatMessage,
  HermesChatThreadSummary,
  HermesCompletePathItem,
  HermesChatContextBreakdown,
  HermesHistoryWindow,
  HermesChatUsageSnapshot,
  HermesChatApprovalEvent,
  HermesChatCredentialRequestEvent,
} from '../../../../shared/types/hermesChat';
import { mapUsageSnapshot } from './hermesUsageMap';
import { parkApprovalRequest } from './hermesApprovals';
import {
  isCredentialRequestKind,
  parkCredentialRequest,
  respondToCredentialRequest,
} from './hermesCredentialRequests';
import { toUnixSeconds } from '../../../../shared/messageTime';
import { uniquePreserveOrder, writtenPathsOf } from '../../../../shared/hermesToolPaths';
import { filedTaskOf } from '../../../../shared/hermesKanbanFiled';
import type { KanbanFiledTask } from '../../../../shared/types/hermesKanban';

export { mapUsageSnapshot } from './hermesUsageMap';

/** Source tag for sessions minted by Boundary's in-app chat. */
export const BOUNDARY_SESSION_SOURCE = 'boundary';

type EventHandler = (event: GatewayEvent) => void;
type ApprovalNotifier = (event: HermesChatApprovalEvent) => void;
/** Returns false when no renderer could be asked. */
type CredentialRequestNotifier = (event: HermesChatCredentialRequestEvent) => boolean;
type SessionsChangedNotifier = () => void;

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
  /** Whether `session.live_status` answers for one session. */
  liveStatus: boolean;
}

export class HermesGatewaySession {
  private client: JsonRpcGatewayClient | null = null;
  private sessionId: string | null = null;
  /**
   * Runtime session id → stored (state.db) id. The gateway hands out a runtime id on
   * create / resume; anything that writes lineage (`parent_session_id`) needs the stored
   * one, or the row fails its foreign key and the branch is never saved.
   */
  private storedIds = new Map<string, string>();
  private storedIdArchive: StoredIdArchive | null = null;
  private connecting: Promise<void> | null = null;
  private approvalUnsub: (() => void) | null = null;
  private sessionsChangedUnsub: (() => void) | null = null;
  private approvalNotifier: ApprovalNotifier | null = null;
  private credentialRequestNotifier: CredentialRequestNotifier | null = null;
  private sessionsChangedNotifier: SessionsChangedNotifier | null = null;
  // This connection's `gateway.capabilities`, asked once per connection ({} when unanswered).
  private capabilities: {
    client: JsonRpcGatewayClient;
    value: Promise<Record<string, unknown>>;
  } | null = null;

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  setApprovalNotifier(notifier: ApprovalNotifier | null): void {
    this.approvalNotifier = notifier;
  }

  setCredentialRequestNotifier(notifier: CredentialRequestNotifier | null): void {
    this.credentialRequestNotifier = notifier;
  }

  setSessionsChangedNotifier(notifier: SessionsChangedNotifier | null): void {
    this.sessionsChangedNotifier = notifier;
  }

  setStoredIdArchive(archive: StoredIdArchive | null): void {
    this.storedIdArchive = archive;
  }

  private linkStored(runtimeId: string, storedId: string): void {
    this.storedIds.set(runtimeId, storedId);
    if (runtimeId !== storedId) this.storedIdArchive?.set(runtimeId, storedId);
  }

  async ensureConnected(): Promise<JsonRpcGatewayClient> {
    const openClient = (): JsonRpcGatewayClient | null => {
      const client = this.client;
      if (client && client.connectionState === 'open') {
        return client;
      }
      return null;
    };

    const already = openClient();
    if (already) return already;

    if (this.connecting) {
      await this.connecting;
      const afterWait = openClient();
      if (afterWait) return afterWait;
    }

    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }

    const connected = openClient();
    if (!connected) {
      throw new Error('Hermes gateway failed to connect');
    }
    return connected;
  }

  private async connect(): Promise<void> {
    const { ticket, dashboardBaseUrl } = await mintDashboardWsTicket();
    const parsed = new URL(dashboardBaseUrl);
    const wsUrl = buildHermesWebSocketUrl({
      protocol: parsed.protocol,
      host: parsed.host,
      path: '/api/ws',
      authParam: ['ticket', ticket],
    });

    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.sessionsChangedUnsub?.();
    this.sessionsChangedUnsub = null;

    const client = new JsonRpcGatewayClient({
      requestIdPrefix: 'b',
      requestTimeoutMs: 180_000,
    });

    await client.connect(wsUrl);

    // Wait for gateway.ready (or proceed after a short timeout).
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        unsub();
        resolve();
      }, 3_000);
      const unsub = client.on('gateway.ready' as never, () => {
        clearTimeout(timeout);
        unsub();
        resolve();
      });
    });

    // Older gateways may not expose client.capabilities; do not fail the session.
    try {
      await client.request('client.capabilities', { server_requests: true });
    } catch {
      /* optional on this stack */
    }

    this.approvalUnsub = client.onRequest((request: ServerRequest) => {
      if (isCredentialRequestKind(request.method)) {
        const credentialEvent = parkCredentialRequest(request);
        // No renderer to ask: answer "skipped" now rather than leave Hermes waiting.
        if (!credentialEvent) {
          request.respond({ value: '' });
          return true;
        }
        if (!this.credentialRequestNotifier?.(credentialEvent)) {
          respondToCredentialRequest({ rpcRequestId: credentialEvent.rpcRequestId });
        }
        return true;
      }
      if (request.method !== 'approval') {
        return false;
      }
      const event = parkApprovalRequest(request);
      if (!event) {
        request.fail(-32603, 'invalid approval request');
        return true;
      }
      this.approvalNotifier?.(event);
      return true;
    });

    this.sessionsChangedUnsub = client.on('sessions.changed', () => {
      this.sessionsChangedNotifier?.();
      emitHermesSessionsChanged();
      broadcastSessionsChanged();
    });

    this.client = client;

    try {
      await this.replayPendingApprovals();
    } catch {
      /* optional */
    }
  }

  private async replayPendingApprovals(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const result = (await client.request('approval.pending', {
      session_id: this.sessionId ?? '',
    })) as {
      approvals?: Array<Record<string, unknown>>;
    };
    const approvals = result.approvals ?? [];
    for (const row of approvals) {
      const requestId =
        typeof row.request_id === 'string' ? row.request_id : null;
      if (!requestId) continue;
      const sessionId =
        typeof row.session_id === 'string'
          ? row.session_id
          : this.sessionId ?? '';
      if (!sessionId) continue;
      const synthetic: ServerRequest = {
        id: `pending:${requestId}`,
        method: 'approval',
        params: {
          session_id: sessionId,
          request_id: requestId,
          command: typeof row.command === 'string' ? row.command : undefined,
          description:
            typeof row.description === 'string' ? row.description : undefined,
          tool_name:
            typeof row.tool_name === 'string' ? row.tool_name : undefined,
          choices: row.choices as never,
          allow_session: row.allow_session as never,
          allow_permanent: row.allow_permanent as never,
          smart_denied: row.smart_denied as never,
          pattern_key: row.pattern_key as never,
          mcp: row.mcp as never,
        },
        replayed: true,
        respond: () => undefined,
        fail: () => undefined,
      };
      const event = parkApprovalRequest(synthetic);
      if (event) {
        pendingViaQueue.add(event.rpcRequestId);
        this.approvalNotifier?.(event);
      }
    }
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

  async createSession(): Promise<string> {
    return this.createSessionWithSeed();
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
    const result = (await requestWithHistoryBudget(client, 'session.create', params)) as {
      session_id?: string;
      id?: string;
      stored_session_id?: string | null;
    };
    const id = result.session_id ?? result.id;
    if (!id) {
      throw new Error('session.create returned no session id');
    }
    if (result.stored_session_id) this.linkStored(id, result.stored_session_id);
    this.sessionId = id;
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

  async describeProfile(name: string): Promise<{ soul?: string | null }> {
    const client = await this.ensureConnected();
    const params = name.trim()
      ? { name: name.trim() }
      : {};
    return (await client.request('profiles.describe', params)) as {
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
    const result = (await requestWithHistoryBudget(client, 'session.resume', params)) as {
      session_id?: string;
      stored_session_id?: string | null;
      messages?: TranscriptRow[];
      messages_omitted?: boolean | null;
    };
    const runtimeId = result.session_id ?? sessionId;
    this.linkStored(runtimeId, result.stored_session_id || sessionId);
    this.sessionId = runtimeId;
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

  async createProject(params: {
    name: string;
    folders?: string[];
    primaryPath?: string;
    slug?: string;
    use?: boolean;
  }): Promise<{ id: string; name: string; primaryPath?: string | null }> {
    const client = await this.ensureConnected();
    const result = (await client.request('projects.create', {
      name: params.name,
      folders: params.folders ?? null,
      primary_path: params.primaryPath ?? null,
      slug: params.slug ?? null,
      use: params.use ?? true,
    })) as {
      project?: {
        id?: string;
        name?: string;
        primary_path?: string | null;
      } | null;
    };
    const project = result.project;
    if (!project?.id) {
      throw new Error('projects.create returned no project');
    }
    return {
      id: project.id,
      name: project.name ?? params.name,
      primaryPath: project.primary_path,
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

  async getSessionUsage(sessionId: string): Promise<HermesChatUsageSnapshot> {
    const client = await this.ensureConnected();
    const result = (await client.request('session.usage', {
      session_id: sessionId,
    })) as Record<string, unknown>;
    return mapUsageSnapshot(result);
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
  async getMaxTurns(): Promise<number | null> {
    const client = await this.ensureConnected();
    try {
      const result = (await client.request('config.get', {
        path: 'agent.max_turns',
      })) as { value?: unknown };
      const value = result.value;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
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

  on(event: string, handler: EventHandler): () => void {
    if (!this.client) {
      return () => undefined;
    }
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
      /**
       * Turn context: added to this turn's model input, never to `session.history`. Only
       * send it when supportsClientContext() is true.
       */
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
    if (this.capabilities?.client !== client) {
      const value = client
        .request('gateway.capabilities', {})
        .then((caps) => (caps && typeof caps === 'object' ? (caps as Record<string, unknown>) : {}))
        .catch(() => ({}));
      this.capabilities = { client, value };
    }
    return this.capabilities.value;
  }

  /**
   * Whether the gateway sends `turn.heartbeat` (and how often) and answers
   * `session.live_status`. A stack overlay, so an unpatched gateway offers neither.
   */
  async getTurnLiveness(): Promise<TurnLiveness> {
    const caps = await this.getCapabilities();
    const every = Number(caps.turn_heartbeat_s);
    return {
      heartbeatS: caps.turn_heartbeat === true && Number.isFinite(every) && every > 0 ? every : null,
      liveStatus: caps.session_live_status === true,
    };
  }

  /**
   * Whether `prompt.submit` takes a `context` string (stack v0.3.3 overlay). An unpatched
   * gateway answers the unknown field with `4000`, so check before sending it.
   */
  async supportsClientContext(): Promise<boolean> {
    return (await this.getCapabilities()).client_context === true;
  }

  /**
   * Where Hermes says a session stands ('working', 'waiting', 'idle', …), or null when it
   * is not live. Throws when the gateway cannot answer.
   */
  async getLiveStatus(sessionId: string, profile?: string | null): Promise<string | null> {
    const client = await this.ensureConnected();
    const params: Record<string, unknown> = {};
    if (profile?.trim()) params.profile = profile.trim();
    if ((await this.getTurnLiveness()).liveStatus) {
      const result = (await client.request('session.live_status', {
        ...params,
        session_id: sessionId,
      })) as { status?: string; running?: boolean };
      return result.status ?? (result.running ? 'working' : 'idle');
    }
    // Unpatched gateway: pick the session out of the full live list.
    const result = (await client.request('session.active_list', {
      ...params,
      current_session_id: sessionId,
    })) as {
      sessions?: Array<{ id?: string; session_key?: string; status?: string }>;
    };
    const live = (result.sessions ?? []).find(
      (s) => s.id === sessionId || s.session_key === sessionId
    );
    return live?.status ?? null;
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    const client = this.client;
    if (!client || client.connectionState !== 'open') return;
    try {
      await client.request('session.interrupt', { session_id: sessionId });
    } catch {
      /* best-effort */
    }
  }

  dispose(): void {
    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.sessionsChangedUnsub?.();
    this.sessionsChangedUnsub = null;
    this.approvalNotifier = null;
    this.sessionsChangedNotifier = null;
    this.client?.close();
    this.client = null;
    this.sessionId = null;
  }
}

const disabledToolsetsBySession = new Map<string, string[]>();
/** rpcRequestIds that came from approval.pending (must use approval.respond). */
export const pendingViaQueue = new Set<string>();

let sharedGateway: HermesGatewaySession | null = null;

export function getHermesGatewaySession(): HermesGatewaySession {
  if (!sharedGateway) {
    sharedGateway = new HermesGatewaySession();
  }
  return sharedGateway;
}

/** Test helper — reset the singleton between unit tests. */
export function resetHermesGatewaySessionForTests(): void {
  sharedGateway?.dispose();
  sharedGateway = null;
  disabledToolsetsBySession.clear();
  pendingViaQueue.clear();
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

/**
 * The gateway's unknown-key refusal for `history_budget` (Hermes v2026.9+ answers `4000`
 * with the key path when the stack's contract doesn't declare it).
 */
function refusesHistoryBudget(err: unknown): boolean {
  return (
    err instanceof JsonRpcGatewayError && err.code === 4000 && err.message.includes('history_budget')
  );
}

/**
 * Send a create or resume that may carry `history_budget`. A stack without the CR 0002
 * overlay refuses the field, so that refusal alone is retried once without it: the chat
 * still opens, just with no budget and no horizon. Any other error is thrown as is, so a
 * timed-out create is never sent twice.
 */
async function requestWithHistoryBudget(
  client: { request: (method: string, params: Record<string, unknown>) => Promise<unknown> },
  method: 'session.create' | 'session.resume',
  params: Record<string, unknown>
): Promise<unknown> {
  if (!('history_budget' in params)) return client.request(method, params);
  try {
    return await client.request(method, params);
  } catch (err) {
    if (!refusesHistoryBudget(err)) throw err;
    // Logged so a stack that drops the budget can't hide behind the retry.
    console.warn(`[hermesGatewaySession] ${method} refused history_budget; retrying without it`, err);
    const { history_budget: _dropped, ...rest } = params;
    return client.request(method, rest);
  }
}
