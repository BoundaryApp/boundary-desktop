/**
 * Extract file/path-like strings from Hermes tool args payloads.
 * Prefer explicit keys; never invent paths.
 */
export function extractPathsFromToolArgs(
  args: Record<string, unknown> | null | undefined
): string[] {
  if (!args || typeof args !== 'object') return [];

  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      out.push(value.trim());
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          out.push(item.trim());
        } else if (item && typeof item === 'object' && 'path' in item) {
          const p = (item as { path?: unknown }).path;
          if (typeof p === 'string' && p.trim()) out.push(p.trim());
        }
      }
    }
  };

  for (const key of ['path', 'file', 'target', 'filename', 'filepath']) {
    if (key in args) push(args[key]);
  }
  for (const key of ['paths', 'files', 'targets']) {
    if (key in args) push(args[key]);
  }

  return uniquePreserveOrder(out);
}

/** Strip a container mount prefix so the UI can show host-relative names. */
export function toHostRelativePath(
  path: string,
  containerPath?: string | null
): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (containerPath) {
    const base = containerPath.replace(/\/+$/, '');
    if (trimmed === base) return '.';
    if (trimmed.startsWith(`${base}/`)) {
      return trimmed.slice(base.length + 1);
    }
  }
  const opt = trimmed.match(/^\/opt\/projects\/[^/]+\/(.+)$/);
  if (opt?.[1]) return opt[1];
  return trimmed;
}

/** Hermes tools that write files (tools/file_tools.py); reads and searches are left out. */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(['write_file', 'patch']);

/** Paths a tool call wrote, from its args; empty for tools that only read. */
export function writtenPathsOf(
  name: string | null | undefined,
  args: Record<string, unknown> | null | undefined
): string[] {
  return name && FILE_WRITING_TOOLS.has(name) ? extractPathsFromToolArgs(args) : [];
}

/**
 * The path relative to one project's mount, or null when the tool path is not inside it.
 * Stricter than toHostRelativePath: only this project's container path counts, so a
 * file can be revealed on the host only when Boundary knows exactly where it lives.
 */
export function projectRelativePath(
  path: string,
  containerPath?: string | null
): string | null {
  if (!containerPath) return null;
  const base = containerPath.replace(/\/+$/, '');
  const trimmed = path.trim();
  if (!trimmed.startsWith(`${base}/`)) return null;
  const rel = trimmed.slice(base.length + 1);
  if (!rel || rel.split('/').some((part) => part === '..')) return null;
  return rel;
}

export function uniquePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function formatToolCardMeta(opts: {
  name: string;
  status: 'running' | 'generating' | 'done';
  turn?: number;
  maxTurns?: number;
}): string {
  const verb =
    opts.status === 'done'
      ? 'Ran'
      : opts.status === 'generating'
        ? 'Generating'
        : 'Reading';
  const name = opts.name || 'tool';
  if (opts.turn != null && opts.maxTurns != null) {
    return `${verb} ${name} · turn ${opts.turn} of ${opts.maxTurns}`;
  }
  if (opts.turn != null) {
    return `${verb} ${name} · turn ${opts.turn}`;
  }
  return `${verb} ${name}`;
}

export function formatTurnStatsLine(stats: {
  prompt?: number | null;
  generated?: number | null;
  visible?: number | null;
  ttftSec?: number | null;
  avgTps?: number | null;
}): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (stats.prompt != null) {
    rows.push({ label: 'prompt', value: formatCompactTokens(stats.prompt) });
  }
  if (stats.generated != null) {
    rows.push({ label: 'generated', value: formatCompactTokens(stats.generated) });
  }
  if (stats.visible != null) {
    rows.push({ label: 'visible', value: String(stats.visible) });
  }
  if (stats.ttftSec != null && Number.isFinite(stats.ttftSec)) {
    rows.push({ label: 'TTFT', value: `${stats.ttftSec.toFixed(1)}s` });
  }
  if (stats.avgTps != null && stats.avgTps > 0) {
    rows.push({ label: 'tok/s', value: stats.avgTps.toFixed(0) });
  }
  return rows;
}

function formatCompactTokens(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    if (Number.isInteger(k)) return `${k}k`;
    return `${k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}
