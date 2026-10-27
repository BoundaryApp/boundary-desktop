/**
 * Sends the answer to one parked server request. Throws when the answer can't reach Hermes
 * (the socket that asked is gone, or the RPC that carries it failed).
 */
export type ParkedResponder = (result: Record<string, unknown>) => void | Promise<void>;

export type ParkedAnswer = { success: true } | { success: false; error: string };

/**
 * Server requests (approvals, credential prompts) waiting on the user, keyed by the JSON-RPC
 * id Hermes asked with. An entry leaves when its answer was sent, when Hermes withdraws it
 * (`request.cancel`), or when the connection that asked drops (`clear`).
 */
export class ParkedRequests<E extends { rpcRequestId: string; sessionId: string }> {
  private readonly entries = new Map<string, { event: E; respond: ParkedResponder }>();

  park(event: E, respond: ParkedResponder): void {
    this.entries.set(event.rpcRequestId, { event, respond });
  }

  get(rpcRequestId: string): E | undefined {
    return this.entries.get(rpcRequestId)?.event;
  }

  find(match: (event: E) => boolean): E | undefined {
    for (const { event } of this.entries.values()) if (match(event)) return event;
    return undefined;
  }

  /** Send `result` for a parked request. The entry stays when the answer wasn't sent. */
  async answer(rpcRequestId: string, result: Record<string, unknown>): Promise<ParkedAnswer> {
    const entry = this.entries.get(rpcRequestId);
    if (!entry) return { success: false, error: 'No pending request for that id' };
    try {
      await entry.respond(result);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.entries.delete(rpcRequestId);
    return { success: true };
  }

  drop(rpcRequestId: string): boolean {
    return this.entries.delete(rpcRequestId);
  }

  /** Waiting requests, oldest first; with `sessionIds`, only those sessions'. */
  list(sessionIds?: readonly string[]): E[] {
    const events = [...this.entries.values()].map((entry) => entry.event);
    return sessionIds ? events.filter((event) => sessionIds.includes(event.sessionId)) : events;
  }

  /** Forget every request and return them. */
  clear(): E[] {
    const events = this.list();
    this.entries.clear();
    return events;
  }
}
