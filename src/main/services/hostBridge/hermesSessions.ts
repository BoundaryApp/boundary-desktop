/**
 * The Hermes processes connected to the bridge right now, as MCP sessions (ADR 0027 phase 4). A
 * process counts once it has listed the tools. Every `initialize` opens a new session, so a
 * process that re-initializes (a restart, `reload.mcp`, a dropped keepalive) would count twice if
 * old sessions stayed. They leave when Hermes ends them (HTTP `DELETE`) or go quiet for longer
 * than the keepalive allows: Hermes pings each session on the keepalive interval Boundary
 * provisions.
 */
export class LiveHermesSessions {
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now
  ) {}

  get count(): number {
    return this.lastSeen.size;
  }

  /** A JSON-RPC request on a session. Returns whether the count changed. A client without a session counts once. */
  seen(method: string, sessionId: string | null): boolean {
    const key = sessionId ?? 'no-session';
    if (this.lastSeen.has(key)) {
      this.lastSeen.set(key, this.now());
      return false;
    }
    if (method !== 'tools/list') return false;
    this.lastSeen.set(key, this.now());
    return true;
  }

  /** Hermes ended the session. Returns whether the count changed. */
  closed(sessionId: string): boolean {
    return this.lastSeen.delete(sessionId);
  }

  /** Drop sessions that have been quiet too long. Returns whether the count changed. */
  sweep(): boolean {
    const cutoff = this.now() - this.idleMs;
    let changed = false;
    for (const [key, at] of this.lastSeen) {
      if (at < cutoff) {
        this.lastSeen.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}
