import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { persistDebugLog } from '../../persistDebugLog';
import { stopUtilityProcess } from '../stopUtilityProcess';
import { NETWORK_ENTRY } from './networkEntry';
import type { MainToNetwork, NetworkSpikeMode, NetworkToMain } from './networkMessages';

/**
 * Phase 0 of the Circles plan: a debug-only way to run the network utilityProcess (ADR 0032 §1,
 * §9) in a packaged build. Nothing starts it unless `BOUNDARY_CIRCLES_SPIKE` is set at launch;
 * every report goes to the debug log under `circles-network`.
 */

const STOP_TIMEOUT_MS = 5_000;

let child: UtilityProcess | null = null;

/** `load`, `seed`, or the 64-character hex key of a Hypercore to replicate. Anything else is null. */
export function networkSpikeModeFrom(value: string | undefined): NetworkSpikeMode | null {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === 'load' || trimmed === 'seed') return { kind: trimmed };
  if (trimmed && /^[0-9a-f]{64}$/.test(trimmed)) return { kind: 'replicate', key: trimmed };
  return null;
}

function post(target: UtilityProcess, message: MainToNetwork): void {
  target.postMessage(message);
}

export function startCirclesNetworkSpike(): void {
  const setting = process.env.BOUNDARY_CIRCLES_SPIKE;
  if (!setting || child) return;
  const mode = networkSpikeModeFrom(setting);
  if (!mode) {
    persistDebugLog('circles-network', 'BOUNDARY_CIRCLES_SPIKE not understood', { value: setting });
    return;
  }

  const proc = utilityProcess.fork(NETWORK_ENTRY, [], { serviceName: 'Boundary Circles Network' });
  child = proc;
  persistDebugLog('circles-network', 'forked', { mode: mode.kind, pid: proc.pid ?? null });

  proc.on('message', (message: NetworkToMain) => {
    switch (message.type) {
      case 'addons':
        persistDebugLog(
          'circles-network',
          message.missing.length === 0 ? 'all native addons loaded' : 'native addons missing',
          { loaded: message.loaded, missing: message.missing }
        );
        return;
      case 'start-failed':
        persistDebugLog('circles-network', 'start failed', { error: message.error, addons: message.addons });
        return;
      case 'log':
        persistDebugLog('circles-network', message.message, message.data ?? {});
        return;
      // The spike never sends `circles-start`, so Circles and shared-model answers don't come here.
      case 'stopped':
      case 'circles-ready':
      case 'circles-snapshot':
      case 'circles-reply':
      case 'shared-head':
      case 'shared-chunk':
      case 'shared-end':
      case 'diag':
        return;
    }
  });
  proc.once('exit', (code) => {
    if (child === proc) child = null;
    persistDebugLog('circles-network', 'exited', { code });
  });

  post(proc, { type: 'start', storageDir: path.join(app.getPath('userData'), 'circles-spike'), mode });
}

/** Asks the process to close the swarm and store, and kills it if it hasn't exited in time. */
export async function stopCirclesNetworkSpike(): Promise<void> {
  const proc = child;
  if (!proc) return;
  child = null;
  await stopUtilityProcess(proc, () => post(proc, { type: 'stop' }), STOP_TIMEOUT_MS);
}
