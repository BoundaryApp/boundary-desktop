/**
 * A fake `WebSocket` for gateway tests, installed as `globalThis.WebSocket` so the real
 * `HermesGatewaySession` and vendored `JsonRpcGatewayClient` run against it. It records the
 * frames the client sends, answers each request from `FakeGatewaySocket.results`, and lets a
 * test push server events and server→client requests.
 */
type Frame = Record<string, unknown>;

export class FakeGatewaySocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeGatewaySocket[] = [];
  /** Per-method result for client requests; default {}. A function answers from the params. */
  static results: Record<string, unknown> = {};
  /** Per-method JSON-RPC error for client requests. */
  static errors: Record<string, { code: number; message: string }> = {};

  readyState = 0;
  sent: Frame[] = [];

  constructor(public url: string) {
    super();
    FakeGatewaySocket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
      setTimeout(() => this.serverEvent({ type: 'gateway.ready', payload: {} }), 2);
    }, 1);
  }

  send(text: string): void {
    const frame = JSON.parse(text) as Frame;
    this.sent.push(frame);
    if (typeof frame.method !== 'string' || frame.id == null) return;
    const method = frame.method;
    const error = FakeGatewaySocket.errors[method];
    const answer = FakeGatewaySocket.results[method];
    const result = typeof answer === 'function' ? (answer as (p: unknown) => unknown)(frame.params) : (answer ?? {});
    setTimeout(
      () => this.push(error ? { jsonrpc: '2.0', id: frame.id, error } : { jsonrpc: '2.0', id: frame.id, result }),
      1
    );
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }));
  }

  push(frame: Frame): void {
    if (this.readyState !== 1) return;
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(frame) }));
  }

  serverEvent(params: Frame): void {
    this.push({ jsonrpc: '2.0', method: 'event', params });
  }

  serverRequest(id: string, method: string, params: Frame): void {
    this.push({ jsonrpc: '2.0', id, method, params });
  }

  /** Methods of the requests this socket sent, in order. */
  methods(): string[] {
    return this.sent.filter((f) => typeof f.method === 'string').map((f) => String(f.method));
  }

  /** The frame answering server request `id`, if the client sent one. */
  answerTo(id: string): Frame | undefined {
    return this.sent.find((f) => f.id === id && f.method === undefined);
  }

  static reset(): void {
    FakeGatewaySocket.all = [];
    FakeGatewaySocket.results = {};
    FakeGatewaySocket.errors = {};
  }

  static get latest(): FakeGatewaySocket {
    return FakeGatewaySocket.all[FakeGatewaySocket.all.length - 1];
  }
}

export const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
