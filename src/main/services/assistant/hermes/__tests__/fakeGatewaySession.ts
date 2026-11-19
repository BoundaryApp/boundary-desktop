/**
 * Stands in for `getHermesGatewaySession()`: the methods a test passes, plus an `on` event bus
 * that the test drives with `emit`. Only the methods given exist, so code that calls another
 * one fails as it would against a hand-written mock. Create it with `vi.hoisted` so the
 * `vi.mock` factory can return it:
 *
 *   const gw = await vi.hoisted(async () =>
 *     (await import('./fakeGatewaySession')).fakeGatewaySession({ getSessionHistory: vi.fn() })
 *   );
 *   vi.mock('../hermesGatewaySession', () => ({ getHermesGatewaySession: () => gw.session }));
 */
import type { Mock } from 'vitest';

export interface GatewayEvent {
  session_id?: string;
  payload?: unknown;
}

export type GatewayHandler = (event: GatewayEvent) => void;

export interface FakeGatewayOptions {
  /**
   * Call the handler set as it is while emitting, so a handler added during an emit also runs.
   * By default `emit` calls the handlers registered when it started.
   */
  liveHandlers?: boolean;
}

export interface FakeGatewaySession<F extends Record<string, Mock>> {
  session: F & { on: (name: string, handler: GatewayHandler) => () => void };
  /** Call the handlers registered for `name`. */
  emit: (name: string, event: GatewayEvent) => void;
  /** How many handlers are registered for `name`. */
  listenerCount: (name: string) => number;
  /** Drop every registered handler. */
  clearHandlers: () => void;
  fns: F;
}

export function fakeGatewaySession<F extends Record<string, Mock>>(
  fns: F,
  options: FakeGatewayOptions = {}
): FakeGatewaySession<F> {
  const handlers = new Map<string, Set<GatewayHandler>>();
  const on = (name: string, handler: GatewayHandler) => {
    const set = handlers.get(name) ?? new Set<GatewayHandler>();
    set.add(handler);
    handlers.set(name, set);
    return () => {
      set.delete(handler);
    };
  };
  const emit = (name: string, event: GatewayEvent) => {
    const set = handlers.get(name) ?? new Set<GatewayHandler>();
    for (const handler of options.liveHandlers ? set : [...set]) handler(event);
  };
  return {
    session: { ...fns, on },
    emit,
    listenerCount: (name) => handlers.get(name)?.size ?? 0,
    clearHandlers: () => handlers.clear(),
    fns,
  };
}
