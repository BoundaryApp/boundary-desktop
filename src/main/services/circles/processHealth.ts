import v8 from 'node:v8';

const MB = 2 ** 20;
const mb = (bytes: number) => Math.round(bytes / MB);

type Memory = Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'external' | 'arrayBuffers'>;
type HeapSpace = Pick<v8.HeapSpaceInfo, 'space_name' | 'space_used_size'>;

/**
 * The process's memory for the heartbeat. Heap spaces tell many small objects (old space) apart
 * from a few large ones (large object space); empty spaces are left out.
 */
export function processHealth(memory: Memory = process.memoryUsage(), spaces: HeapSpace[] = v8.getHeapSpaceStatistics()) {
  const heapSpacesMb: Record<string, number> = {};
  for (const space of spaces) {
    const used = mb(space.space_used_size);
    if (used > 0) heapSpacesMb[space.space_name.replace(/_space$/, '')] = used;
  }
  return {
    rssMb: mb(memory.rss),
    heapMb: mb(memory.heapUsed),
    externalMb: mb(memory.external),
    arrayBuffersMb: mb(memory.arrayBuffers),
    heapSpacesMb,
  };
}
