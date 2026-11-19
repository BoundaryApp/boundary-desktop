import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CircleChannel, CircleJoinState, CircleSnapshot } from '../../../shared/types/circles';
import { useDismiss } from '../../components/ui/use-dismiss';
import { AtMark } from '../chat/circle/AtMark';
import { openSettings } from '../settingsNavigation';
import { keyHue } from './CircleControls';
import { CircleRowMenu } from './CircleRowMenu';
import type { CircleAction } from './circlesNavigation';
import { hiddenUnread, type HiddenUnread } from './unreadChip';
import { circleMentioned, circleUnread } from './useCircleChat';
import '../chat/circle/circleChat.css';

export const CircleTile: React.FC<{ circle: CircleSnapshot; size?: number }> = ({ circle, size = 26 }) => (
  <span
    className="wb-circle-tile"
    style={{ background: keyHue(circle.key), width: size, height: size }}
    aria-hidden="true"
  >
    {(circle.name || '?').slice(0, 2).toUpperCase()}
  </span>
);

export const ClockTile: React.FC = () => (
  <span className="wb-circle-tile is-plain" style={{ width: 20, height: 20 }} aria-hidden="true">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  </span>
);

export const JOINING_NAME = 'Joining a Circle…';

function joiningLine(join: CircleJoinState): string {
  return join.error ? 'Couldn’t join' : 'Waiting for an admin';
}

/** The list's `+`: a small menu with the start and join sheets (ADR 0043 §7). */
const AddMenu: React.FC<{ onStart: () => void; onJoin: () => void }> = ({ onStart, onJoin }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));
  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <div className="wb-circles-add" ref={rootRef}>
      <button
        type="button"
        className="wb-sect-add"
        title="Start or join a Circle"
        aria-label="Start or join a Circle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M7 2.75v8.5M2.75 7h8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open ? (
        <div className="wb-circles-menu" role="menu" aria-label="Start or join">
          <button type="button" role="menuitem" onClick={() => choose(onStart)}>
            Start a Circle…
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onJoin)}>
            Join with an invite…
          </button>
        </div>
      ) : null}
    </div>
  );
};

/**
 * A Circle row's unread count and mention mark, in the dock and the desktop panel. The Circle open
 * beside the list shows its own counts, so its row shows none.
 */
export function circleRowUnread(
  circle: CircleSnapshot,
  channels: CircleChannel[] | undefined,
  directUnread: number | undefined,
  open: boolean
): { shown: number; mention: boolean; label: string } {
  const shown = open ? 0 : circleUnread(channels) + (directUnread ?? 0);
  const mention = shown > 0 && circleMentioned(channels);
  return { shown, mention, label: `${circle.name}${shown ? `, ${shown} unread${mention ? ', mentions you' : ''}` : ''}` };
}

/** A Circle row's tile, name and count. */
export const CircleRowContent: React.FC<{ circle: CircleSnapshot; shown: number; mention: boolean }> = ({
  circle,
  shown,
  mention,
}) => (
  <>
    <CircleTile circle={circle} size={20} />
    <span className="wb-row-title">{circle.name}</span>
    {shown ? (
      <span className={`wb-rail-count${mention ? ' has-mention' : ''}`}>
        {mention ? <AtMark /> : null}
        {shown}
      </span>
    ) : null}
  </>
);

/** Why Circles can't connect, with the way to the Circles profile. */
export const CirclesProblem: React.FC<{ problem: string; onOpenProfile?: () => void }> = ({
  problem,
  onOpenProfile = () => openSettings({ tab: 'general' }),
}) => (
  <p className="wb-circles-note is-warn">
    Circles can’t connect: {problem}{' '}
    <button type="button" className="wb-circles-link" onClick={onOpenProfile}>
      Circles profile
    </button>
  </p>
);

function sameChip(a: HiddenUnread | null, b: HiddenUnread | null): boolean {
  if (!a || !b) return a === b;
  return a.count === b.count && a.direction === b.direction && a.target === b.target;
}

export interface CirclesDockProps {
  circles: CircleSnapshot[];
  /** Each Circle's channels with unread counts, by Circle key. */
  channels: Record<string, CircleChannel[] | undefined>;
  /** Each Circle's unread direct messages, by Circle key. */
  directUnread?: Record<string, number>;
  /** The Circle open on the screen, whose row is marked. */
  openKey: string | null;
  onOpenCircle: (key: string) => void;
  /** A row's ⋯ menu: opens the Circle, then the sheet or tab for the action. */
  onCircleAction: (key: string, action: CircleAction) => void;
  /** A join in progress or its failure, shown as a row until it ends or is dismissed. */
  join?: CircleJoinState | null;
  joiningOpen: boolean;
  onJoining: () => void;
  /** Circles this user left that no admin has confirmed yet, listed until one is online. */
  leaving?: { key: string; name: string }[];
  onStart: () => void;
  onJoin: () => void;
  /** Why Circles can't connect, when they can't. */
  problem?: string | null;
}

/**
 * The dock of the Circles rail (Circles screen spec decision 22): every Circle once, by name, with
 * search for when there are many. A Circle with unread messages is bold and shows its count; the
 * order never changes with reading. The open Circle's row is marked, not expanded.
 */
export const CirclesDock: React.FC<CirclesDockProps> = ({
  circles,
  channels,
  directUnread = {},
  openKey,
  onOpenCircle,
  onCircleAction,
  join,
  joiningOpen,
  onJoining,
  leaving = [],
  onStart,
  onJoin,
  problem,
}) => {
  const [query, setQuery] = useState('');
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const byName = useMemo(
    () => [...circles].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [circles]
  );
  const needle = query.trim().toLocaleLowerCase();
  const shownCircles = needle ? byName.filter((circle) => circle.name.toLocaleLowerCase().includes(needle)) : byName;

  const rowsRef = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState<HiddenUnread | null>(null);
  const hasRows = circles.length > 0 || Boolean(join) || leaving.length > 0;

  // Unread rows scrolled out of the dock's view: measured after each render, on scroll and on resize.
  const measure = useCallback(() => {
    const scroller = rowsRef.current;
    const unread = scroller ? Array.from(scroller.querySelectorAll<HTMLElement>('[data-unread]')) : [];
    // The scroller's bottom padding is the room under the chip, so a row in it counts as hidden.
    const view = scroller ? scroller.getBoundingClientRect() : null;
    const padding = scroller ? Number.parseFloat(window.getComputedStyle(scroller).paddingBottom) || 0 : 0;
    const next =
      scroller && view
        ? hiddenUnread(
            unread.map((el) => el.getBoundingClientRect()),
            { top: view.top, bottom: view.bottom - padding }
          )
        : null;
    setChip((was) => (sameChip(was, next) ? was : next));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    const scroller = rowsRef.current;
    if (!scroller) return undefined;
    scroller.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [hasRows, measure]);
  const showHiddenUnread = () => {
    if (!chip) return;
    const unread = rowsRef.current?.querySelectorAll<HTMLElement>('[data-unread]');
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    unread?.[chip.target]?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  };

  const row = (circle: CircleSnapshot) => {
    const menuOpen = menuRow === circle.key;
    const on = circle.key === openKey;
    const { shown, mention, label } = circleRowUnread(circle, channels[circle.key], directUnread[circle.key], on);
    return (
      <div
        key={circle.key}
        data-unread={shown ? '' : undefined}
        className={`wb-circles-row-wrap${menuOpen ? ' is-menu-open' : ''}`}
      >
        <button
          type="button"
          className={`wb-row has-mark wb-circles-row${on ? ' is-on' : ''}${shown ? ' is-unread' : ''}`}
          aria-current={on ? 'true' : undefined}
          aria-label={label}
          onClick={() => onOpenCircle(circle.key)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenuRow(circle.key);
          }}
        >
          <CircleRowContent circle={circle} shown={shown} mention={mention} />
        </button>
        <CircleRowMenu
          circle={circle}
          open={menuOpen}
          onOpenChange={(next) => setMenuRow(next ? circle.key : null)}
          onAction={(action) => onCircleAction(circle.key, action)}
        />
      </div>
    );
  };

  return (
    <div className="wb-circles-list">
      <div className="wb-sect">
        <span className="wb-sect-name">Circles</span>
        <AddMenu onStart={onStart} onJoin={onJoin} />
      </div>
      {circles.length ? (
        <input
          type="search"
          className="wb-circles-search"
          placeholder="Search Circles"
          aria-label="Search Circles"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {problem ? <CirclesProblem problem={problem} /> : null}
      {hasRows ? (
        <>
          <div ref={rowsRef} className="wb-circles-dock-rows" role="group" aria-label="Circle list">
            {join ? (
              <button
                type="button"
                className={`wb-row has-mark wb-circles-row${joiningOpen ? ' is-on' : ''}`}
                aria-current={joiningOpen ? 'true' : undefined}
                aria-label={`${JOINING_NAME} ${joiningLine(join)}`}
                onClick={onJoining}
              >
                <ClockTile />
                <span className="wb-row-title">
                  {JOINING_NAME}
                  <small className="wb-circles-row-line">{joiningLine(join)}</small>
                </span>
              </button>
            ) : null}
            {leaving.map((left) => (
              <div key={left.key} className="wb-row has-mark wb-circles-row is-static" role="note">
                <ClockTile />
                <span className="wb-row-title">
                  Leaving {left.name || 'a Circle'}
                  <small className="wb-circles-row-line">Finishes when an admin is online</small>
                </span>
              </div>
            ))}
            {circles.length ? (
              shownCircles.length ? (
                shownCircles.map(row)
              ) : (
                <p className="wb-hint">No Circle is called that.</p>
              )
            ) : null}
          </div>
          {chip ? (
            <button
              type="button"
              className="wb-circles-chip"
              aria-label={`${chip.count} unread ${chip.count === 1 ? 'Circle' : 'Circles'} ${chip.direction === 'down' ? 'below' : 'above'}`}
              onClick={showHiddenUnread}
            >
              {chip.count} unread {chip.direction === 'down' ? '↓' : '↑'}
            </button>
          ) : null}
        </>
      ) : null}
      {hasRows ? null : (
        <p className="wb-hint">
          A Circle is a small invite-only group. Members’ Macs connect to each other directly and keep its chat.
        </p>
      )}
    </div>
  );
};
