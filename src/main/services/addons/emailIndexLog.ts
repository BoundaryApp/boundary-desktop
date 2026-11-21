import type { EmailAccountState } from '../../../shared/types/addons';
import { ADDON_SLUG_PATTERN } from '../../../shared/utils/slug';
import { isRecord } from '../../../shared/utils/isRecord';

export interface IndexerLog {
  lastPass: { at: string; inScope: number; failed: Record<string, 4 | 5> } | null;
  skipped: Record<string, { at: string; reason: string }>;
  /** When each pass in the log ended, oldest first, counting passes that printed only an error code. */
  passEnds: string[];
  /** The time of the log's latest line of any kind, or null for an empty log. */
  latestAt: string | null;
}

/**
 * Boundary's last change to an account. A pass line carries only its end time, and the indexer
 * stops only between passes (or is killed mid-pass without printing a line), so a pass line seen
 * after a change may belong to a pass that started before it. A pass counts for a change only when
 * it is known to have started after it.
 */
export interface AccountChange {
  /** Boundary's clock at the change. */
  at: string;
  /**
   * A log time after which every pass line comes from a pass that started after the change: ''
   * when Email was off at the change (email-indexer was stopped, so no pass was running), the
   * latest log line's time read once a restart Boundary ran after the change had finished, or
   * null when neither is known. With null, the second pass line after the change is the first
   * that counts, since passes run one after another.
   */
  startedAfter: string | null;
}

export interface EmailAccountHealth {
  state: EmailAccountState;
  detail: string | null;
  indexedAt: string | null;
}

// `docker compose logs --timestamps --no-log-prefix`: "<RFC 3339 timestamp> <payload>".
const LINE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/;
// email-indexer's skip line: "email-indexer: <slug>: <reason>".
const SKIP = new RegExp(`^email-indexer: (${ADDON_SLUG_PATTERN}): (.+)$`);

/**
 * Reads the latest pass and the skip reasons printed for it from the indexer log. Only slugs,
 * reasons, counts and codes are kept; no other text from a line is stored.
 */
export function parseIndexerLog(text: string): IndexerLog {
  const log: IndexerLog = { lastPass: null, skipped: {}, passEnds: [], latestAt: null };
  // The stack prints a pass's skip lines before that pass's JSON line, so skip lines seen
  // since the previous pass line belong to the next one.
  let pending: IndexerLog['skipped'] = {};
  for (const raw of text.split('\n')) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const at = m[1];
    const payload = m[2];
    log.latestAt = at;

    if (payload.startsWith('{')) {
      let obj: unknown;
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      // A pass that printed nothing is {"error": "<code>"} only: it still ended a pass.
      if (typeof obj.in_scope === 'number' || typeof obj.error === 'string') log.passEnds.push(at);
      if (typeof obj.in_scope !== 'number') continue;
      const failed: Record<string, 4 | 5> = {};
      if (isRecord(obj.failed)) {
        for (const [id, code] of Object.entries(obj.failed)) {
          if (code === 4 || code === 5) failed[id] = code;
        }
      }
      log.lastPass = { at, inScope: obj.in_scope, failed };
      log.skipped = pending;
      pending = {};
      continue;
    }

    const skip = SKIP.exec(payload);
    if (skip) pending[skip[1]] = { at, reason: skip[2] };
  }
  // Skip lines after the latest pass line are the newest rendering, from a pass in progress.
  log.skipped = { ...log.skipped, ...pending };
  return log;
}

const WAITING: EmailAccountHealth = { state: 'waiting', detail: null, indexedAt: null };

/** Whether the pass that ended at `end` started after `change`. */
function startedAfter(end: string, change: AccountChange, log: IndexerLog): boolean {
  const t = Date.parse(end);
  const at = Date.parse(change.at);
  if (!(t > at)) return false;
  if (change.startedAfter === '') return true;
  if (change.startedAfter !== null && t > Date.parse(change.startedAfter)) return true;
  // An earlier pass also ended after the change, so this one began after that.
  return log.passEnds.some((e) => {
    const et = Date.parse(e);
    return et > at && et < t;
  });
}

export function accountState(
  slug: string,
  host: string,
  change: AccountChange | null,
  log: IndexerLog,
): EmailAccountHealth {
  const skip = log.skipped[slug];
  if (skip) {
    // A skip line opens a pass, so one printed before the change is about the old settings.
    if (change !== null && Date.parse(change.at) > Date.parse(skip.at)) return WAITING;
    return { state: 'left_out', detail: skip.reason, indexedAt: null };
  }

  const pass = log.lastPass;
  if (!pass) return WAITING;
  if (change !== null && !startedAfter(pass.at, change, log)) return WAITING;

  const code = pass.failed[slug];
  if (code === 4) return { state: 'login_refused', detail: null, indexedAt: null };
  if (code === 5) return { state: 'unreachable', detail: host, indexedAt: null };
  return { state: 'indexed', detail: null, indexedAt: pass.at };
}
