import { engineCeilingMiB, engineSizeMiB } from './engineSizing';
import type { AddonCatalogEntry } from './types/addons';

const GiB = 1024 ** 3;
const MEMORY_HEADROOM_MIB = 768;
const DISK_TIGHT_BYTES = 10 * GiB;

export interface AddonHostFacts {
  engineMiB: number;
  usedMiB: number;
  hostMiB: number;
  diskFreeBytes: number;
  portInUse: boolean;
  engineResizable: boolean;
  /** Memory reserved by what is already turned on (ADR 0055 §1). Absent counts as none. */
  reservedMiB?: number;
  /**
   * False when the engine runs on a host Boundary doesn't control, so none of the figures above
   * were measured and every check passes. Absent counts as measured.
   */
  measured?: boolean;
}

export interface AddonFit {
  verdict: 'ok' | 'tight' | 'over';
  memory: 'ok' | 'tight' | 'over';
  disk: 'ok' | 'tight' | 'over';
  port: 'ok' | 'over';
  freeMiB: number;
  suggestedEngineMiB: number | null;
}

type Level = 'ok' | 'tight' | 'over';

const RANK: Record<Level, number> = { ok: 0, tight: 1, over: 2 };

/** Pure function: compares an add-on's footprint with the engine's free memory, disk and port. */
export function assessAddonFit(entry: AddonCatalogEntry, facts: AddonHostFacts): AddonFit {
  if (facts.measured === false) {
    return { verdict: 'ok', memory: 'ok', disk: 'ok', port: 'ok', freeMiB: 0, suggestedEngineMiB: null };
  }
  const freeMiB = facts.engineMiB - facts.usedMiB;
  const headroomMiB = freeMiB - entry.reserveMiB;

  const memory: Level = headroomMiB >= MEMORY_HEADROOM_MIB ? 'ok' : headroomMiB >= 0 ? 'tight' : 'over';

  const disk: Level =
    facts.diskFreeBytes < 2 * entry.downloadBytes
      ? 'over'
      : facts.diskFreeBytes < DISK_TIGHT_BYTES
        ? 'tight'
        : 'ok';

  const port: 'ok' | 'over' = facts.portInUse ? 'over' : 'ok';

  const levels: Level[] = [memory, disk, port];
  const verdict = levels.reduce<Level>(
    (worst, next) => (RANK[next] > RANK[worst] ? next : worst),
    'ok',
  );

  // The engine size with this add-on on (ADR 0055 §1), or what the stack uses now plus the add-on
  // and 1 GiB, whichever is larger, within what the Mac can spare. Null when that isn't larger
  // than the engine already is.
  let suggestedEngineMiB: number | null = null;
  if (memory === 'over' && facts.engineResizable) {
    const fromUsage = Math.ceil((facts.usedMiB + entry.reserveMiB + 1024) / 1024) * 1024;
    const wanted = Math.max(engineSizeMiB(facts.hostMiB, (facts.reservedMiB ?? 0) + entry.reserveMiB), fromUsage);
    const target = Math.min(engineCeilingMiB(facts.hostMiB), wanted);
    if (target > facts.engineMiB) suggestedEngineMiB = target;
  }

  return { verdict, memory, disk, port, freeMiB, suggestedEngineMiB };
}
