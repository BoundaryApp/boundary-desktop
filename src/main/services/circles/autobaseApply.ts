/**
 * What Circles and shared folders share in Autobase's `apply`: the host calls it uses, the node
 * shape, the loop that skips ack nodes and reports skipped operations, and the Hyperbee view
 * adapter. Free of native modules, so the operation files that use it can be tested on their own.
 */

import type Hyperbee from 'hyperbee';

/** The parts of Autobase's host calls that apply uses. */
export interface ApplyHost {
  addWriter(key: Buffer, opts: { indexer: boolean }): Promise<void>;
  removeWriter(key: Buffer): Promise<void>;
  removeable(key: Buffer): boolean;
  /** Stops applying here until a build that can continue reopens the base. Throws. */
  interrupt(reason: string): void;
}

export interface ApplyNode {
  value: unknown;
  from: { key: Buffer };
}

/** A key-value view as apply sees it. */
export interface ApplyView {
  get(key: string): Promise<{ value: unknown } | null>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Values under a key prefix, in key order. */
  list(prefix: string): Promise<unknown[]>;
}

/** Applies each node in order, skipping ack nodes, and reports why any operation was skipped. */
export async function applyEach(
  nodes: ApplyNode[],
  applyOne: (node: ApplyNode) => Promise<string | null>,
  onSkip?: (reason: string, value: unknown) => void
): Promise<void> {
  for (const node of nodes) {
    // Ack nodes carry null.
    if (node.value === null || node.value === undefined) continue;
    const reason = await applyOne(node);
    if (reason) onSkip?.(reason, node.value);
  }
}

/** The first key past every key that starts with `prefix`, whatever character follows it. */
function pastPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** A Hyperbee as an apply view. */
export function beeView(bee: Hyperbee): ApplyView {
  return {
    get: (key) => bee.get(key),
    put: async (key, value) => {
      await bee.put(key, value);
    },
    del: async (key) => {
      await bee.del(key);
    },
    list: async (prefix) => {
      const values: unknown[] = [];
      for await (const entry of bee.createReadStream({ gte: prefix, lt: pastPrefix(prefix) })) values.push(entry.value);
      return values;
    },
  };
}
