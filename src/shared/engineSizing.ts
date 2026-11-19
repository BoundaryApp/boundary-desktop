/**
 * Memory for Boundary's container engine (ADR 0055 §1), in MiB.
 *
 * The core figure is the default stack's measured peak after a long web search on 2026-11-11
 * (about 3.1 GB across its containers) plus about 0.5 GB for the VM itself, rounded up.
 */
const CORE_STACK_MIB = 4096;
/** Room for Hermes to grow in long turns; it peaked at 1.2 GB under its 3 GiB limit. */
const HEADROOM_MIB = 1024;
const MIN_ENGINE_MIB = 4096;
/** macOS and the user's apps keep at least this much, and at least a quarter of the Mac. */
const MIN_HOST_RESERVE_MIB = 4096;

/** The largest engine this Mac can spare. */
export function engineCeilingMiB(hostMiB: number): number {
  const reserve = Math.max(MIN_HOST_RESERVE_MIB, Math.floor(hostMiB / 4));
  return Math.max(MIN_ENGINE_MIB, hostMiB - reserve);
}

/**
 * The engine size for a Mac with `hostMiB` of memory and `extrasMiB` reserved by the optional
 * services and add-ons that are turned on: core plus headroom plus extras, rounded up to a whole
 * GiB, between the smallest engine and the Mac's ceiling.
 */
export function engineSizeMiB(hostMiB: number, extrasMiB: number): number {
  const wanted = Math.ceil((CORE_STACK_MIB + HEADROOM_MIB + extrasMiB) / 1024) * 1024;
  return Math.min(engineCeilingMiB(hostMiB), Math.max(MIN_ENGINE_MIB, wanted));
}
