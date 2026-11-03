/**
 * Call setup signals (ADR 0044 §1). The renderer runs the peer connections, and main relays its
 * signals: only `call.*` topics cross, each addressed to one member. For now only the transport
 * check's topic exists, and only while the app runs with `BOUNDARY_CALLS_CHECK=1`.
 */
import { app } from 'electron';
import { cleanCallCheckResult, type CallCheckResult } from '../../../shared/callCheck';
import { isCallPart } from '../../../shared/callSignalParts';
import { diag } from './circlesDiagnostics';
import { onCircleSignal, sendCircleSignal } from './circlesService';
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

function appCpuPercent(): number | undefined {
  try {
    return app.getAppMetrics().reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0);
  } catch {
    return undefined;
  }
}

/** Write one result to the Circles diagnostics log, with the app's CPU use. Returns what was written. */
export function logCallCheckResult(input: unknown): CallCheckResult | null {
  if (!callCheckEnabled()) return null;
  const result = cleanCallCheckResult(input);
  if (!result) return null;
  const cpu = appCpuPercent();
  const logged = cpu === undefined ? result : { ...result, cpuPercent: Math.round(cpu * 10) / 10 };
  diag('call.check', { ...logged });
  return logged;
}
