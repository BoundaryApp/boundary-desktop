import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuiState } from '@assistant-ui/store';
import { dmDays, matchOffsets, shortDate, stepMatch } from './dmThreadIndex';
import { formatTokenCount } from './dmHorizon';

/** Message text the find bar searches: prompts and replies, not times or action rows. */
const SEARCHABLE = '.wb-log .wb-msg .wb-bubble-body, .wb-log .wb-msg .wb-prose';
const HIGHLIGHT = 'wb-find';
const HIGHLIGHT_CURRENT = 'wb-find-current';

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlights(): { registry: HighlightRegistry; Highlight: HighlightCtor } | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function clearHighlights(): void {
  const api = highlights();
  api?.registry.delete(HIGHLIGHT);
  api?.registry.delete(HIGHLIGHT_CURRENT);
}

/** Every match of `query` in the loaded messages, in log order, as DOM ranges. */
function findRanges(query: string): Range[] {
  const ranges: Range[] = [];
  if (!query.trim()) return ranges;
  for (const root of document.querySelectorAll<HTMLElement>(SEARCHABLE)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const [start, end] of matchOffsets(node.textContent ?? '', query)) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        ranges.push(range);
      }
    }
  }
  return ranges;
}

function messageOf(range: Range): HTMLElement | null {
  const el = range.startContainer.parentElement;
  return el?.closest<HTMLElement>('.wb-msg') ?? null;
}

/**
 * Top of a DM's log: *Ongoing since {date} · Jump to date · Search this DM* (Phase 7a).
 * Jump to date lists the days that have messages and scrolls to that day's divider.
 */
export const DmLogHead: React.FC<{ startedAt?: string | null; onSearch: () => void }> = ({
  startedAt,
  onSearch,
}) => {
  const messages = useAuiState((s) => s.thread.messages);
  const days = useMemo(() => dmDays(messages), [messages]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  const sinceMs = days[0]?.ms ?? (Number.isFinite(startedMs) ? startedMs : null);
  if (messages.length === 0) return null;

  const jump = (key: string) => {
    setOpen(false);
    const divider = [...document.querySelectorAll<HTMLElement>('.wb-log .wb-day')].find(
      (el) => el.dataset.day === key
    );
    divider?.scrollIntoView?.({ block: 'start' });
  };

  return (
    <div className="wb-dm-earlier" ref={wrapRef}>
      {sinceMs != null ? <span>Ongoing since {shortDate(sinceMs)}</span> : null}
      {days.length > 0 ? (
        <>
          {sinceMs != null ? ' · ' : null}
          <button
            type="button"
            className="wb-link"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            Jump to date
          </button>
        </>
      ) : null}
      {' · '}
      <button type="button" className="wb-link" onClick={onSearch} title="Search this DM (⌘F)">
        Search this DM
      </button>
      {open ? (
        <div
          className="wb-dm-days"
          role="listbox"
          aria-label="Jump to date"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setOpen(false);
          }}
        >
          {days.map((day) => (
            <button
              key={day.key}
              type="button"
              role="option"
              aria-selected={false}
              className="wb-dm-day"
              onClick={() => jump(day.key)}
            >
              {day.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Search this DM: matches loaded messages in place, with next / previous. Enter and
 * Shift+Enter step; Esc closes and hands focus back to the composer (Phase 7a).
 */
export const DmFindBar: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [current, setCurrent] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const messageCount = useAuiState((s) => s.thread.messages.length);

  useEffect(() => {
    inputRef.current?.focus();
    return clearHighlights;
  }, []);

  // Re-run when the query changes or a message lands; start at the newest match.
  useLayoutEffect(() => {
    const next = findRanges(query);
    setRanges(next);
    setCurrent(next.length > 0 ? next.length - 1 : -1);
  }, [query, messageCount]);

  useLayoutEffect(() => {
    document
      .querySelectorAll('.wb-log .wb-msg.is-find-current')
      .forEach((el) => el.classList.remove('is-find-current'));
    const api = highlights();
    if (api) {
      api.registry.set(HIGHLIGHT, new api.Highlight(...ranges));
      api.registry.set(HIGHLIGHT_CURRENT, new api.Highlight(...(current >= 0 ? [ranges[current]] : [])));
    }
    if (current < 0) return;
    const message = messageOf(ranges[current]);
    message?.classList.add('is-find-current');
    ranges[current].startContainer.parentElement?.scrollIntoView?.({ block: 'center' });
  }, [ranges, current]);

  useEffect(
    () => () =>
      document
        .querySelectorAll('.wb-log .wb-msg.is-find-current')
        .forEach((el) => el.classList.remove('is-find-current')),
    []
  );

  const step = (delta: 1 | -1) => setCurrent((c) => stepMatch(c, ranges.length, delta));
  const status = !query.trim()
    ? ''
    : ranges.length === 0
      ? 'No matches'
      : `${current + 1} of ${ranges.length}`;

  return (
    <div className="wb-find" role="search" aria-label="Search this DM">
      <input
        ref={inputRef}
        type="search"
        className="wb-find-input"
        placeholder="Search this DM"
        aria-label="Search this DM"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="wb-find-count" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        className="wb-btn-tiny"
        aria-label="Previous match"
        disabled={ranges.length === 0}
        onClick={() => step(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="wb-btn-tiny"
        aria-label="Next match"
        disabled={ranges.length === 0}
        onClick={() => step(1)}
      >
        ↓
      </button>
      <button type="button" className="wb-btn-tiny" aria-label="Close search" onClick={onClose}>
        Esc
      </button>
    </div>
  );
};

/** The DM context horizon for this thread: the line goes above message `index` (Phase 7b). */
export const DmHorizonContext = createContext<{ index: number; label: string } | null>(null);

/** True for messages above the horizon: still readable, but the next reply won't see them. */
export function useBeyondHorizon(): boolean {
  const horizon = useContext(DmHorizonContext);
  const index = useAuiState((s) => s.message.index);
  return horizon != null && index < horizon.index;
}

/** The dashed line, drawn above the first message the next reply sees. */
export const DmHorizonMark: React.FC = () => {
  const horizon = useContext(DmHorizonContext);
  const index = useAuiState((s) => s.message.index);
  if (!horizon || index !== horizon.index) return null;
  return (
    <div className="wb-horizon" role="separator" aria-label={horizon.label}>
      <span className="wb-horizon-pill">{horizon.label}</span>
    </div>
  );
};

/** Composer chip: the DM sends recent history up to its budget. Shown only with a budget. */
export const DmContextChip: React.FC<{ budget: number; agentName: string }> = ({
  budget,
  agentName,
}) => (
  <span
    className="wb-chip wb-context-chip"
    title={`${agentName} sees the most recent ${formatTokenCount(budget)} tokens of this DM, plus memory. Older messages stay here.`}
  >
    Context: recent · {formatTokenCount(budget)}
  </span>
);
