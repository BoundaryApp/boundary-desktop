import type { HostToolsState } from '../../../shared/types/hostBridge';
import { HERMES_BRIDGE_KEEPALIVE_S, HERMES_BRIDGE_PARKED_RETRY_S } from './hermesProvision';

/**
 * When the chat may say Hermes can use the host tools (ADR 0027 phase 4).
 *
 * Several Hermes processes connect to the bridge (one per gateway profile, plus the dashboard),
 * and each one that gave up while Boundary was closed retries on the parked interval Boundary
 * provisions. The first to connect says nothing about the one serving the chat, so wait for as
 * many as connected last time, or until every parked process has had its retry.
 */

/**
 * Counted from the first Hermes client of a launch (Hermes is up by then): the provisioned
 * parked-server retry (15 s) plus room for the reconnect itself. A stack that ignores the
 * provisioned interval retries every 300 s, and may settle before its last process is back.
 */
export const HOST_TOOLS_SETTLE_MS = HERMES_BRIDGE_PARKED_RETRY_S * 1000 + 30_000;
/**
 * After the stack accepts a wake: every parked process reconnects within about a second, and a
 * request stays live for 30 s for any still on its last retries.
 */
export const HOST_TOOLS_WAKE_SETTLE_MS = 30_000;

/** Two missed keepalives (Hermes pings each session every 15 s, as provisioned), plus slack. */
export const HERMES_SESSION_IDLE_MS = 2 * HERMES_BRIDGE_KEEPALIVE_S * 1000 + 5_000;

/** `settled`: every process that gave up on the bridge has had its chance to reconnect. */
export function hostToolsStateFor(clients: number, expected: number, settled: boolean): HostToolsState {
  if (clients === 0) return 'waiting';
  if (expected > 0 && clients >= expected) return 'connected';
  return settled ? 'connected' : 'waiting';
}

/**
 * The count to expect next launch. Once settled, this run's count stands (so it can shrink when
 * the stack changes); before that it only grows.
 */
export function nextExpectedClients(stored: number, clients: number, settled: boolean): number {
  if (settled && clients > 0) return clients;
  return Math.max(stored, clients);
}
