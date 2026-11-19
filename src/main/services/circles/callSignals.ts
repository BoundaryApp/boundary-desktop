/**
 * Call setup signals (ADR 0044 §1). The renderer runs the peer connections, and main relays its
 * signals: only `call.*` topics cross. The call service uses `call.state`, sent to the whole
 * Circle or to one member, `call.part` and `call.ring`, sent to one member; all relay whenever Circles run. The transport
 * check's `call.check` topic, its address and its logs exist only while the app runs with
 * `BOUNDARY_CALLS_CHECK=1`. Tunnels serve both.
 */
import { app } from 'electron';
import { cleanCallCheckResult, cleanCallCheckSample, type CallCheckResult } from '../../../shared/callCheck';
import { isCallPart } from '../../../shared/callSignalParts';
import { cleanCallLog } from '../../../shared/calls/callLog';
import { CALL_PART_TOPIC, CALL_STATE_TOPIC, cleanCallState } from '../../../shared/calls/callMessages';
import { CALL_RING_TOPIC, cleanCallRing, isPersonRoom } from '../../../shared/calls/callRing';
import { diag } from './circlesDiagnostics';
import type { CirclesResult } from '../../../shared/types/circles';
import { callTunnel, getCallContext, getCirclesState, onCircleSignal, sendCircleSignal } from './circlesService';
import type { CallContext, CallTunnelReply } from './networkMessages';
import { broadcast } from '../windows';

const CHECK_TOPIC = 'call.check';
const HEX_KEY = /^[0-9a-f]{64}$/;

export function callCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BOUNDARY_CALLS_CHECK === '1';
}

/** Send one part of a check message to one member. False when the check is off or the input is wrong. */
export function sendCallCheckSignal(circleKey: string, toIdentity: string, part: unknown): boolean {
  if (!callCheckEnabled()) return false;
  if (!HEX_KEY.test(circleKey) || !HEX_KEY.test(toIdentity) || !isCallPart(part)) return false;
  return sendCircleSignal(circleKey, CHECK_TOPIC, part, toIdentity);
}

/** Pass members' check parts to the renderer on `circles:call-signal`. Does nothing while the check is off. */
export function listenForCallSignals(): () => void {
  if (!callCheckEnabled()) return () => undefined;
  return onCircleSignal(CHECK_TOPIC, ({ circleKey, fromIdentity, payload }) => {
    if (isCallPart(payload)) broadcast('circles:call-signal', { circleKey, from: fromIdentity, part: payload });
  });
}

/**
 * Send the call service's signals: a state to the whole Circle or, with `to`, to one member (a
 * private room's state needs `to`); a part or a ring to one member. False for anything else, or when Circles aren't running.
 */
export function sendCallSignal(input: unknown): boolean {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (typeof raw.key !== 'string' || !HEX_KEY.test(raw.key)) return false;
  if (raw.topic === CALL_STATE_TOPIC) {
    const state = cleanCallState(raw.state);
    if (!state) return false;
    // A private room's state goes only to the person in it.
    if (raw.to === undefined) return !isPersonRoom(state.room) && sendCircleSignal(raw.key, CALL_STATE_TOPIC, state);
    if (typeof raw.to !== 'string' || !HEX_KEY.test(raw.to)) return false;
    return sendCircleSignal(raw.key, CALL_STATE_TOPIC, state, raw.to);
  }
  if (raw.topic === CALL_RING_TOPIC) {
    const ring = cleanCallRing(raw.ring);
    if (!ring || typeof raw.to !== 'string' || !HEX_KEY.test(raw.to)) return false;
    return sendCircleSignal(raw.key, CALL_RING_TOPIC, ring, raw.to);
  }
  if (raw.topic === CALL_PART_TOPIC) {
    if (typeof raw.to !== 'string' || !HEX_KEY.test(raw.to) || !isCallPart(raw.part)) return false;
    return sendCircleSignal(raw.key, CALL_PART_TOPIC, raw.part, raw.to);
  }
  return false;
}

/** Pass members' call states, parts and rings to the renderer on `circles:call`, cleaned, with the sending device. */
export function listenForCalls(): () => void {
  const stopState = onCircleSignal(CALL_STATE_TOPIC, ({ circleKey, fromIdentity, fromDevice, payload }) => {
    const state = cleanCallState(payload);
    if (state) broadcast('circles:call', { circleKey, from: fromIdentity, device: fromDevice, topic: CALL_STATE_TOPIC, state });
  });
  const stopPart = onCircleSignal(CALL_PART_TOPIC, ({ circleKey, fromIdentity, fromDevice, payload }) => {
    if (isCallPart(payload)) {
      broadcast('circles:call', { circleKey, from: fromIdentity, device: fromDevice, topic: CALL_PART_TOPIC, part: payload });
    }
  });
  const stopRing = onCircleSignal(CALL_RING_TOPIC, ({ circleKey, fromIdentity, fromDevice, payload }) => {
    const ring = cleanCallRing(payload);
    if (ring) broadcast('circles:call', { circleKey, from: fromIdentity, device: fromDevice, topic: CALL_RING_TOPIC, ring });
  });
  return () => {
    stopState();
    stopPart();
    stopRing();
  };
}

/** Write a call's connect or end to the Circles diagnostics log. False for anything else. */
export function logCallEvent(input: unknown): boolean {
  const event = cleanCallLog(input);
  if (!event) return false;
  diag(event.ev, event.fields);
  return true;
}

const TUNNEL_ACTIONS = ['open', 'stats', 'close'] as const;

/** Open, read or close a call tunnel for the call service or the check, to one device when `device` is given. Refused for wrong input. */
export async function callTunnelRequest(input: unknown): Promise<CirclesResult<CallTunnelReply>> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const action = TUNNEL_ACTIONS.find((word) => word === raw.action);
  const refuse = (error: string) => ({ success: false as const, error, state: getCirclesState() });
  if (
    !action ||
    typeof raw.key !== 'string' ||
    !HEX_KEY.test(raw.key) ||
    typeof raw.to !== 'string' ||
    !HEX_KEY.test(raw.to) ||
    !Number.isInteger(raw.tunnel) ||
    (raw.tunnel as number) < 1 ||
    (raw.tunnel as number) > 0xffffff ||
    (raw.device !== undefined && (typeof raw.device !== 'string' || !HEX_KEY.test(raw.device)))
  ) {
    return refuse('Bad tunnel request.');
  }
  return callTunnel(action, raw.key, raw.to, raw.tunnel as number, raw.device as string | undefined);
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The app's CPU use now, in all and by process kind (main, renderers, GPU, utility processes). */
function appCpu(): Partial<CallCheckResult> {
  try {
    const metrics = app.getAppMetrics();
    const by = (types: string[]) =>
      round(metrics.filter((metric) => types.includes(metric.type)).reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0));
    return {
      cpuPercent: round(metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0)),
      cpuBrowser: by(['Browser']),
      cpuRenderer: by(['Tab']),
      cpuGpu: by(['GPU']),
      cpuUtility: by(['Utility']),
    };
  } catch {
    return {};
  }
}

/**
 * A result or sample as log fields. The log line's own `run` is the app launch and its `t` the
 * wall-clock time, so the check's run id goes in `check` and a sample's seconds in `atS`.
 */
function eventFields({ run, t, ...rest }: { run: string; t?: number }): Record<string, unknown> {
  return { check: run, ...(t === undefined ? {} : { atS: t }), ...rest };
}

/**
 * Write one result to the Circles diagnostics log, with the app's CPU use and, when given, the
 * DHT's view of this network and the Circles connection to the member. Returns what was written.
 */
export function logCallCheckResult(input: unknown, context: CallContext | null = null): CallCheckResult | null {
  if (!callCheckEnabled()) return null;
  const result = cleanCallCheckResult(input);
  if (!result) return null;
  const logged: CallCheckResult = { ...result, ...appCpu(), ...(context ?? {}) };
  diag('call.check', eventFields(logged));
  return logged;
}

/** `logCallCheckResult` for the renderer: fetches the connection context for that member first. */
export async function recordCallCheckResult(input: unknown): Promise<CallCheckResult | null> {
  if (!callCheckEnabled()) return null;
  const raw = (input ?? {}) as { key?: unknown; to?: unknown; result?: unknown };
  let context: CallContext | null = null;
  if (typeof raw.key === 'string' && HEX_KEY.test(raw.key) && typeof raw.to === 'string' && HEX_KEY.test(raw.to)) {
    const reply = await getCallContext(raw.key, raw.to).catch((): null => null);
    if (reply?.success) context = reply.context;
  }
  return logCallCheckResult(raw.result, context);
}

/** Write one sample to the diagnostics log as `call.sample`, with the app's CPU use. */
export function logCallCheckSample(input: unknown): boolean {
  if (!callCheckEnabled()) return false;
  const sample = cleanCallCheckSample(input);
  if (!sample) return false;
  diag('call.sample', eventFields({ ...sample, ...appCpu() }));
  return true;
}
