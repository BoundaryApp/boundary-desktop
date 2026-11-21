import { persistDebugLog, serializeError } from '../../persistDebugLog';
import { requireStackCapability } from '../stackHost/capabilities';

/**
 * Reservations of add-ons being installed that asked for room (ADR 0055 §3). They count towards
 * the engine's size, so the machine's next start grows it instead of shrinking it back to what is
 * installed. The installer releases its reservation when the install ends either way.
 */
const pending = new Map<string, { reserveMiB: number; floorMiB: number }>();

export function pendingReservationsMiB(): Record<string, number> {
  return Object.fromEntries([...pending].map(([id, { reserveMiB }]) => [id, reserveMiB]));
}

/**
 * The smallest engine an add-on being installed asked for: the fit check's size, which counts what
 * the stack uses now as well as what is turned on. 0 when none is pending.
 */
export function pendingEngineFloorMiB(): number {
  return Math.max(0, ...[...pending.values()].map(({ floorMiB }) => floorMiB));
}

export function releasePendingReservation(id: string): void {
  pending.delete(id);
}

export class MakeRoomCancelled extends Error {
  constructor() {
    super('Making room was cancelled before the engine stopped.');
  }
}

export interface MakeRoomDeps {
  /** True when the stack runs on Boundary's own Podman machine, the only engine Boundary sizes. */
  engineResizable(): Promise<boolean>;
  /** Puts the stack in its starting state with this message, so the start-up screen shows. */
  announce(message: string): void;
  /** Stops the stack's containers without the quit overlay. */
  stopStack(): Promise<void>;
  /** Stops the bundled machine. */
  stopMachine(): Promise<void>;
  /** Starts the machine (resizing it to the engine's size first) and the stack. */
  startStack(): Promise<{ success: boolean; error?: string }>;
}

/**
 * Restart the engine at a size that includes `reserveMiB` for `id` (ADR 0055 §3, §5). `signal`
 * cancels it until the stack starts stopping; after that the steps run to the end. When the
 * start fails, the reservation is dropped and the stack started again at the old size, and the
 * returned promise rejects with what happened.
 */
export async function makeRoomFor(
  id: string,
  name: string,
  reserveMiB: number,
  floorMiB: number,
  deps: MakeRoomDeps,
  signal?: AbortSignal
): Promise<void> {
  requireStackCapability('engineControl');
  if (!(await deps.engineResizable())) {
    throw new Error(`${name} needs more memory than the container engine has, and Boundary can't resize this engine.`);
  }
  if (signal?.aborted) throw new MakeRoomCancelled();
  pending.set(id, { reserveMiB, floorMiB });
  persistDebugLog('addons', 'making room', { id, reserveMiB, floorMiB });
  deps.announce(`Making room for ${name}…`);
  try {
    await deps.stopStack();
    await deps.stopMachine();
  } catch (error) {
    // Nothing was resized; bring back what was running.
    pending.delete(id);
    persistDebugLog('addons', 'making room failed while stopping', serializeError(error));
    await deps.startStack();
    throw error;
  }
  const started = await deps.startStack();
  if (started.success) return;
  pending.delete(id);
  persistDebugLog('addons', 'making room failed; starting at the old size', { error: started.error ?? null });
  const again = await deps.startStack();
  throw new Error(
    again.success
      ? `Couldn't give the container engine more memory, so ${name} wasn't installed. The engine is back at its old size. ${started.error ?? ''}`.trim()
      : `Couldn't give the container engine more memory, and the assistant didn't start again. ${again.error ?? started.error ?? ''}`.trim()
  );
}
