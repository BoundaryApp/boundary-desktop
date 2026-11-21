import { formatBytes } from '../../../shared/utils/format';

/** The facts a delete or removal review leads with: what's in a folder and when it last changed. */

export interface FolderContentsFacts {
  files?: number;
  bytes?: number;
  nodeModulesBytes?: number;
  truncated?: boolean;
}

export function formatWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'Unknown';
  const when = new Date(iso);
  const sameDay = when.toDateString() === now.toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function contentsLine(facts: FolderContentsFacts): string {
  const files = `${facts.truncated ? 'At least ' : ''}${(facts.files ?? 0).toLocaleString()} ${
    facts.files === 1 ? 'file' : 'files'
  }`;
  const size = formatBytes(facts.bytes ?? 0);
  const deps =
    facts.nodeModulesBytes && facts.nodeModulesBytes > 0
      ? `, of which ${formatBytes(facts.nodeModulesBytes)} is node_modules`
      : '';
  return `${files} · ${size}${deps}`;
}
