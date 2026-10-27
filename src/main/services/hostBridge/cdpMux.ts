import { blockedMethodReason, blockedUrlReason, type SitePolicy } from './cdpPolicy';

/**
 * Shares one Chrome DevTools connection (the debugging pipe) between several CDP clients
 * (ADR 0027 §4–6). Hermes opens more than one: its driver, plus a dialog supervisor.
 *
 * - Ids: every command gets a pipe-wide id; replies go back to the sender under its own id.
 * - Sessions: a client may only use sessions it attached. Two clients on the same page get two
 *   sessions, so no session is ever shared.
 * - Browser-wide auto-attach and target discovery are emulated per client instead of forwarded:
 *   Chrome keeps one setting for the whole pipe, which clients would otherwise fight over.
 * - Policy: blocked methods are refused; navigations, new tabs, attaches and pages that change
 *   to a blocked URL are refused or closed.
 * - A client's sessions are detached when it disconnects.
 *
 * No I/O here: Chrome and the clients are callbacks, so the routing is testable with fakes.
 */

// CDP messages are untyped JSON from Chrome or a client; fields are checked where they are used.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export interface CdpClient {
  send(message: Json): void;
  close(): void;
}

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  [key: string]: unknown;
}

interface ClientState {
  client: CdpClient;
  label: string;
  autoAttach: boolean;
  discover: boolean;
  sessions: Set<string>;
  /** Pages this client has a session on, so auto-attach doesn't attach twice. */
  attachedTargets: Set<string>;
  methods: Map<string, number>;
  blocked: Map<string, number>;
}

export interface CdpMuxOptions {
  sendToChrome(message: Json): void;
  policy(): SitePolicy;
  log(message: string, data?: Record<string, unknown>): void;
}

/** Ids for the relay's own commands, far from the forwarded ones. */
const RELAY_ID_BASE = 2_000_000_000;
const ERR_BLOCKED = -32000;
const ERR_NO_SESSION = -32001;

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export class CdpMux {
  private clients = new Map<CdpClient, ClientState>();
  private nextId = 1;
  private nextRelayId = RELAY_ID_BASE;
  private nextClientNumber = 1;
  private pending = new Map<number, { state: ClientState; clientId: unknown; method: string; params: Json }>();
  private relayPending = new Map<number, (message: Json) => void>();
  private sessionOwner = new Map<string, ClientState>();
  private sessionTarget = new Map<string, string>();
  /** Attaches on their way to Chrome, per target: whose session the next attachedToTarget is. */
  private attachQueue = new Map<string, ClientState[]>();
  private targets = new Map<string, TargetInfo>();
  /** Auto-attaches in progress, by `client:target`. */
  private attaching = new Map<string, Promise<void>>();

  constructor(private readonly options: CdpMuxOptions) {}

  /** Call once Chrome is up: the relay watches targets for policy and auto-attach. */
  async start(): Promise<void> {
    await this.relay('Target.setDiscoverTargets', { discover: true });
    const reply = await this.relay('Target.getTargets');
    for (const info of (reply.result?.targetInfos ?? []) as TargetInfo[]) this.targets.set(info.targetId, info);
  }

  addClient(client: CdpClient): void {
    this.clients.set(client, {
      client,
      label: `client-${this.nextClientNumber++}`,
      autoAttach: false,
      discover: false,
      sessions: new Set(),
      attachedTargets: new Set(),
      methods: new Map(),
      blocked: new Map(),
    });
  }

  removeClient(client: CdpClient): void {
    const state = this.clients.get(client);
    if (!state) return;
    this.clients.delete(client);
    for (const [id, entry] of this.pending) if (entry.state === state) this.pending.delete(id);
    for (const targetId of [...this.attachQueue.keys()]) this.unqueueAttach(targetId, state);
    for (const sessionId of state.sessions) {
      this.sessionOwner.delete(sessionId);
      this.sessionTarget.delete(sessionId);
      void this.relay('Target.detachFromTarget', { sessionId });
    }
    this.options.log('cdp client closed', {
      client: state.label,
      methods: Object.fromEntries(state.methods),
      blocked: Object.fromEntries(state.blocked),
    });
  }

  /** Chrome went away: every client is disconnected. */
  chromeClosed(): void {
    for (const resolve of this.relayPending.values()) resolve({ error: { message: 'Chrome closed' } });
    this.relayPending.clear();
    for (const client of [...this.clients.keys()]) {
      this.removeClient(client);
      client.close();
    }
    this.sessionOwner.clear();
    this.sessionTarget.clear();
    this.attachQueue.clear();
    this.targets.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  // ------------------------------------------------------------------ client → Chrome

  handleClientMessage(client: CdpClient, raw: string): void {
    const state = this.clients.get(client);
    if (!state) return;
    let message: Json;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const { id, method, sessionId } = message;
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') return;
    const params: Json = message.params && typeof message.params === 'object' ? message.params : {};
    bump(state.methods, method);

    const reply = (body: Json) => client.send({ id, ...(sessionId ? { sessionId } : {}), ...body });
    const refuse = (code: number, text: string) => {
      bump(state.blocked, method);
      reply({ error: { code, message: text } });
    };

    const blockedMethod = blockedMethodReason(method, params);
    if (blockedMethod) return refuse(ERR_BLOCKED, blockedMethod);
    if (sessionId !== undefined && !state.sessions.has(sessionId)) {
      return refuse(ERR_NO_SESSION, `No session with given id`);
    }

    const url = method === 'Page.navigate' || method === 'Target.createTarget' ? params.url : undefined;
    if (typeof url === 'string') {
      const reason = blockedUrlReason(url, this.options.policy());
      if (reason) return refuse(ERR_BLOCKED, reason);
    }

    if (sessionId === undefined) {
      switch (method) {
        case 'Browser.close':
          // The agent's browser outlives any one client: disconnect this one instead.
          reply({ result: {} });
          setImmediate(() => client.close());
          return;
        case 'Target.attachToBrowserTarget':
          return refuse(ERR_BLOCKED, "Boundary's browser doesn't allow a browser-wide session.");
        case 'Target.setDiscoverTargets':
          state.discover = Boolean(params.discover);
          reply({ result: {} });
          if (state.discover) this.announceTargets(state);
          return;
        case 'Target.setAutoAttach':
          if (params.flatten === false) {
            return refuse(ERR_BLOCKED, "Boundary's browser only supports flattened sessions.");
          }
          state.autoAttach = Boolean(params.autoAttach);
          // Like Chrome: existing pages are announced before the reply.
          void (state.autoAttach ? this.attachExistingPages(state) : Promise.resolve()).then(() =>
            reply({ result: {} })
          );
          return;
        case 'Target.attachToTarget': {
          const target = this.targets.get(params.targetId);
          const reason = target ? blockedUrlReason(target.url, this.options.policy()) : null;
          if (reason) return refuse(ERR_BLOCKED, reason);
          this.queueAttach(params.targetId, state);
          break;
        }
      }
    }

    const globalId = this.nextId++;
    this.pending.set(globalId, { state, clientId: id, method, params });
    this.options.sendToChrome({ ...message, id: globalId, params });
  }

  // ------------------------------------------------------------------ Chrome → clients

  handleChromeMessage(message: Json): void {
    if (typeof message.id === 'number') {
      const relayResolve = this.relayPending.get(message.id);
      if (relayResolve) {
        this.relayPending.delete(message.id);
        relayResolve(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.method === 'Target.attachToTarget') {
        if (message.result?.sessionId) this.own(message.result.sessionId, entry.state, entry.params.targetId);
        // Failed: no attachedToTarget will come for this attach.
        else this.unqueueAttach(entry.params.targetId, entry.state);
      }
      if (entry.method === 'Target.getTargets' && message.sessionId === undefined) {
        // Hide pages on blocked sites, as the emulated discovery does (announceTargets).
        const infos = message.result?.targetInfos;
        if (Array.isArray(infos)) message.result.targetInfos = infos.filter((info: TargetInfo) => this.visible(info));
      }
      const forward = () => entry.state.client.send({ ...message, id: entry.clientId });
      const createdId = entry.method === 'Target.createTarget' ? message.result?.targetId : undefined;
      if (createdId && entry.state.autoAttach) {
        // Chrome announces the new page's session before this reply, and drivers rely on that
        // order (Playwright looks the page up as soon as the reply lands).
        const info = this.targets.get(createdId) ?? { targetId: createdId, type: 'page', url: entry.params.url ?? 'about:blank' };
        void this.attachFor(entry.state, info).then(forward);
        return;
      }
      forward();
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.sessionId !== undefined) this.handleSessionEvent(message);
    else this.handleBrowserEvent(message);
  }

  private handleSessionEvent(message: Json): void {
    const owner = this.sessionOwner.get(message.sessionId);
    if (!owner) return;
    if (message.method === 'Target.attachedToTarget' && message.params?.sessionId) {
      // A child (iframe, worker) of the owner's session.
      this.own(message.params.sessionId, owner, message.params.targetInfo?.targetId);
    } else if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
      this.disown(message.params.sessionId);
    }
    owner.client.send(message);
  }

  private handleBrowserEvent(message: Json): void {
    const params: Json = message.params ?? {};
    switch (message.method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo as TargetInfo;
        this.targets.set(info.targetId, info);
        if (this.closeIfBlocked(info)) return;
        this.toDiscoverers(message);
        if (message.method === 'Target.targetCreated' && info.type === 'page') {
          for (const state of this.clients.values()) if (state.autoAttach) void this.attachFor(state, info);
        }
        return;
      }
      case 'Target.targetDestroyed':
      case 'Target.targetCrashed':
        this.targets.delete(params.targetId);
        this.attachQueue.delete(params.targetId);
        for (const state of this.clients.values()) state.attachedTargets.delete(params.targetId);
        this.toDiscoverers(message);
        return;
      case 'Target.attachedToTarget': {
        const targetId = params.targetInfo?.targetId;
        const owner = this.dequeueAttach(targetId);
        if (!owner || !params.sessionId) return;
        this.own(params.sessionId, owner, targetId);
        owner.client.send(message);
        return;
      }
      case 'Target.detachedFromTarget': {
        const owner = this.sessionOwner.get(params.sessionId);
        this.disown(params.sessionId);
        owner?.client.send(message);
        return;
      }
      default:
        for (const state of this.clients.values()) state.client.send(message);
    }
  }

  // ------------------------------------------------------------------ helpers

  private relay(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextRelayId++;
    return new Promise((resolve) => {
      this.relayPending.set(id, resolve);
      this.options.sendToChrome({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  }

  private own(sessionId: string, state: ClientState, targetId?: string): void {
    if (!this.clients.has(state.client)) return;
    this.sessionOwner.set(sessionId, state);
    state.sessions.add(sessionId);
    if (targetId) {
      this.sessionTarget.set(sessionId, targetId);
      state.attachedTargets.add(targetId);
    }
  }

  private disown(sessionId: string): void {
    const owner = this.sessionOwner.get(sessionId);
    const targetId = this.sessionTarget.get(sessionId);
    this.sessionOwner.delete(sessionId);
    this.sessionTarget.delete(sessionId);
    if (owner) {
      owner.sessions.delete(sessionId);
      if (targetId) owner.attachedTargets.delete(targetId);
    }
  }

  private queueAttach(targetId: string, state: ClientState): void {
    const queue = this.attachQueue.get(targetId) ?? [];
    queue.push(state);
    this.attachQueue.set(targetId, queue);
  }

  private dequeueAttach(targetId: string | undefined): ClientState | undefined {
    if (!targetId) return undefined;
    const queue = this.attachQueue.get(targetId);
    const state = queue?.shift();
    if (queue && !queue.length) this.attachQueue.delete(targetId);
    return state;
  }

  /** Remove one queued attach by `state` for the target, if there is one. */
  private unqueueAttach(targetId: string, state: ClientState): void {
    const queue = this.attachQueue.get(targetId);
    const index = queue?.indexOf(state) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    if (!queue.length) this.attachQueue.delete(targetId);
  }

  private visible(info: TargetInfo): boolean {
    return !blockedUrlReason(info.url, this.options.policy());
  }

  private toDiscoverers(message: Json): void {
    for (const state of this.clients.values()) if (state.discover) state.client.send(message);
  }

  private announceTargets(state: ClientState): void {
    for (const info of this.targets.values()) {
      if (!this.visible(info)) continue;
      state.client.send({ method: 'Target.targetCreated', params: { targetInfo: info } });
    }
  }

  private async attachExistingPages(state: ClientState): Promise<void> {
    const pages = [...this.targets.values()].filter((info) => info.type === 'page');
    await Promise.all(pages.map((info) => this.attachFor(state, info)));
  }

  /**
   * Give `state` its own session on a page, announced the way Chrome's auto-attach would. A second
   * call for the same page waits for the first instead of attaching again.
   */
  private attachFor(state: ClientState, info: TargetInfo): Promise<void> {
    const key = `${state.label}:${info.targetId}`;
    const inFlight = this.attaching.get(key);
    if (inFlight) return inFlight;
    if (state.attachedTargets.has(info.targetId)) return Promise.resolve();
    const attach = this.attachNow(state, info).finally(() => this.attaching.delete(key));
    this.attaching.set(key, attach);
    return attach;
  }

  private async attachNow(state: ClientState, info: TargetInfo): Promise<void> {
    if (blockedUrlReason(info.url, this.options.policy())) return;
    state.attachedTargets.add(info.targetId);
    this.queueAttach(info.targetId, state);
    const reply = await this.relay('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    const sessionId = reply.result?.sessionId as string | undefined;
    if (!sessionId) {
      state.attachedTargets.delete(info.targetId);
      this.dequeueAttach(info.targetId);
      return;
    }
    if (!this.sessionOwner.has(sessionId)) {
      // Chrome didn't announce it (or announced it before the queue saw it): do it here.
      this.dequeueAttach(info.targetId);
      this.own(sessionId, state, info.targetId);
      state.client.send({
        method: 'Target.attachedToTarget',
        params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false },
      });
    }
  }

  private closeIfBlocked(info: TargetInfo): boolean {
    if (info.type !== 'page' || !this.clients.size) return false;
    const reason = blockedUrlReason(info.url, this.options.policy());
    if (!reason) return false;
    this.options.log('closed a page on a blocked site', { reason });
    void this.relay('Target.closeTarget', { targetId: info.targetId });
    return true;
  }
}
