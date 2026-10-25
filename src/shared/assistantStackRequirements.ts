/**
 * Host requirements for running the assistant container stack
 * (core + rag + automation + coding + db) with a remote OpenAI-compatible LLM.
 *
 * Memory ballpark from compose limits / tuning, excluding local LLM cost:
 *   hermes 3G + hermes-webui ~0.5G + searxng/mcp ~0.5G + neo4j ~1.5–2G +
 *   lightrag ~0.5–1.5G + n8n/postgres ~1G + gptr ~0.5G + opencode ~0.5G +
 *   shared postgres + SQL MCP ~0.5G
 *   ≈ 9–12 GB containers → 16 GB host minimum with headroom.
 *
 * Disk is images + volumes for the full UI stack (no Ollama model pulls).
 */
export const ASSISTANT_STACK_REQUIREMENTS = {
  /** Total host RAM in bytes (stack only; LLM is remote) */
  minTotalMemoryBytes: 16 * 1024 * 1024 * 1024,
  /** Logical CPU cores */
  minCpuCores: 4,
  /** Free disk space in bytes (images + volumes for core+rag+automation+coding+db) */
  minFreeDiskBytes: 25 * 1024 * 1024 * 1024,
  requireContainerRuntime: true,
  requireComposeV2: true,
} as const;

/**
 * Running container names that indicate the Boundary-managed assistant stack is up.
 * Matches Boundary's compose overlay (`boundary-*`), not the developer checkout names.
 */
export const ASSISTANT_STACK_RUNNING_CONTAINERS = [
  'boundary-hermes',
  'boundary-hermes-webui',
] as const;

/**
 * Running container names for a local assistant checkout (BOUNDARY_LOCAL_STACK /
 * BOUNDARY_ASSISTANT_ROOT): its own compose names, without Boundary's overlay prefix.
 */
export const LOCAL_ASSISTANT_STACK_RUNNING_CONTAINERS = ['hermes', 'hermes-webui'] as const;

/** Auto-advance delay when the assistant stack is already running. */
export const ASSISTANT_STACK_ALREADY_RUNNING_ADVANCE_MS = 3000;

export function formatBytes(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 1) {
    const rounded = Math.round(gib * 10) / 10;
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
  }
  const mib = bytes / (1024 * 1024);
  return `${Math.round(mib)} MB`;
}
