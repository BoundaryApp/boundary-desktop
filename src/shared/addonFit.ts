import type { AddonCatalogEntry } from './types/addons';

const GiB = 1024 ** 3;
const MEMORY_HEADROOM_MIB = 768;
const DISK_TIGHT_BYTES = 10 * GiB;
const RESIZE_STEP_MIB = 2048;
const RESIZE_OVERHEAD_MIB = 1536;
const HOST_RESERVE_MIB = 8192;

export interface AddonHostFacts {
  engineMiB: number;
  usedMiB: number;
  hostMiB: number;
  diskFreeBytes: number;
  portInUse: boolean;
  engineResizable: boolean;
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

  let suggestedEngineMiB: number | null = null;
  if (memory === 'over' && facts.engineResizable) {
    const needed = facts.usedMiB + entry.reserveMiB + RESIZE_OVERHEAD_MIB;
    const candidate = Math.ceil(needed / RESIZE_STEP_MIB) * RESIZE_STEP_MIB;
    if (candidate <= facts.hostMiB - HOST_RESERVE_MIB) suggestedEngineMiB = candidate;
  }

  return { verdict, memory, disk, port, freeMiB, suggestedEngineMiB };
}
