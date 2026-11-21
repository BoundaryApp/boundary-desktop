import type { RedactionKind, ReportRedaction } from '../../../shared/bugReport';
import { escapeRegExp } from '../../../shared/utils/escapeRegExp';
import { redactSecrets } from '../secrets/redact';

/** This Mac's names, removed wherever they appear. */
export interface ReportIdentity {
  home: string;
  host: string;
  user: string;
  /** Secrets Boundary knows by value. */
  secrets?: string[];
}

const LABEL: Record<RedactionKind, string> = {
  path: '[path]',
  key: '[key]',
  host: '[host]',
  account: '[account]',
};

/** Hosts a report may name: they say how the app reached its own services. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal']);

function mask(kind: RedactionKind, value: string): string {
  return kind === 'key' ? `${value.slice(0, 6)}••••••••` : value;
}

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  /** Which capture group holds the private part; 0 means the whole match. */
  group?: number;
  keep?: (value: string) => boolean;
}

function rules(identity: ReportIdentity): Rule[] {
  const list: Rule[] = [];
  // Home paths first, so the user name inside them counts once, as a path.
  if (identity.home) {
    list.push({ kind: 'path', pattern: new RegExp(`${escapeRegExp(identity.home)}(?:/[^\\s'"\`)\\]]*)?`, 'g') });
  }
  list.push({ kind: 'path', pattern: /(?:\/Users|\/home)\/[^/\s'"`)\]]+(?:\/[^\s'"`)\]]*)?/g });
  list.push({ kind: 'account', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g });
  list.push(
    { kind: 'key', pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g },
    { kind: 'key', pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g },
    { kind: 'key', pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
    { kind: 'key', pattern: /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/gi, group: 1 },
    { kind: 'key', pattern: /\b(?:api[_-]?key|token|secret|password|passwd)\b["']?\s*[:=]\s*["']?([^\s"',;&]{4,})/gi, group: 1 },
    // Long runs of letters and digits: keys and tokens with no known prefix.
    { kind: 'key', pattern: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g }
  );
  if (identity.host) {
    list.push({ kind: 'host', pattern: new RegExp(`\\b${escapeRegExp(identity.host)}\\b`, 'gi') });
  }
  list.push(
    { kind: 'host', pattern: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?(\[[^\]]+\]|[^/\s:'"`)\]]+)/gi, group: 1, keep: (h) => LOCAL_HOSTS.has(h.toLowerCase()) },
    { kind: 'host', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, keep: (h) => LOCAL_HOSTS.has(h) || h.startsWith('127.') },
    { kind: 'host', pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|home|internal|corp)\b/gi, keep: (h) => LOCAL_HOSTS.has(h.toLowerCase()) }
  );
  if (identity.user && identity.user.length >= 3) {
    list.push({ kind: 'account', pattern: new RegExp(`\\b${escapeRegExp(identity.user)}\\b`, 'g') });
  }
  return list;
}

/**
 * Remove this Mac's paths, host and account names, other hosts, and anything that looks like
 * a key, replacing each with a label. Returns what was removed so Review can show it.
 */
export function redactReportText(
  text: string,
  identity: ReportIdentity,
  removed: ReportRedaction[] = []
): { text: string; removed: ReportRedaction[] } {
  let out = text;
  for (const rule of rules(identity)) {
    out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      const value = rule.group ? String(groups[rule.group - 1] ?? '') : match;
      if (!value || value.startsWith('[') || rule.keep?.(value)) return match;
      removed.push({ kind: rule.kind, shown: mask(rule.kind, value) });
      return rule.group ? match.replace(value, LABEL[rule.kind]) : LABEL[rule.kind];
    });
  }
  // Secrets known by value, whatever shape they have.
  const secrets = (identity.secrets ?? []).filter((secret) => secret.length >= 6);
  for (const secret of secrets) {
    if (out.includes(secret)) removed.push({ kind: 'key', shown: mask('key', secret) });
  }
  out = redactSecrets(out, secrets).split('«redacted»').join(LABEL.key);
  return { text: out, removed };
}
