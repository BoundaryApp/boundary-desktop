import React, { useEffect, useRef, useState } from 'react';
import type { CircleJoinState, CircleSnapshot } from '../../../../shared/types/circles';
import type { ChatPlace } from '../circlePlace';
import { keyHue } from '../../circles/CircleControls';
import { peopleLine } from './peopleLine';
import { openSettings } from '../../settingsNavigation';
import './circleChat.css';

export const CircleTile: React.FC<{ circle: CircleSnapshot; size?: number }> = ({ circle, size = 26 }) => (
  <span
    className="wb-place-tile"
    style={{ background: keyHue(circle.key), width: size, height: size }}
    aria-hidden="true"
  >
    {(circle.name || '?').slice(0, 2).toUpperCase()}
  </span>
);

const MacTile: React.FC = () => (
  <span className="wb-place-tile is-mac" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2.5" y="3" width="11" height="7.5" rx="1" />
      <path d="M1 13h14" strokeLinecap="round" />
    </svg>
  </span>
);

const JoiningTile: React.FC = () => (
  <span className="wb-place-tile is-mac" aria-hidden="true">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" strokeLinecap="round" />
    </svg>
  </span>
);

const MAC_LINE = 'Projects, Hermes, your agents';
const JOINING_NAME = 'Joining a Circle…';

/** The joining row's second line. */
function joiningLine(join: CircleJoinState): string {
  return join.error ? 'Couldn’t join' : 'Waiting for an admin';
}

export interface PlaceSwitcherProps {
  place: ChatPlace;
  circles: CircleSnapshot[];
  /** Unread messages by Circle key. */
  unread: Record<string, number>;
  onMac: () => void;
  onCircle: (key: string) => void;
  /** A join in progress or its failure, shown as a row until it ends or is dismissed. */
  join?: CircleJoinState | null;
  onJoining: () => void;
  /** Circles this user left that no admin has confirmed yet, listed until one is online. */
  leaving?: { key: string; name: string }[];
  /** The sheets that start a Circle and join one (ADR 0043 §7). */
  onStart: () => void;
  onJoin: () => void;
  /** Why Circles can't connect, when they can't. */
  problem?: string | null;
}

/**
 * The top of the chat rail: which place the rail shows, This Mac or one Circle, and a menu to
 * switch (Circle chats spec decision 1). It carries the unread total of the other places.
 */
export const PlaceSwitcher: React.FC<PlaceSwitcherProps> = ({
  place,
  circles,
  unread,
  onMac,
  onCircle,
  join,
  onJoining,
  leaving = [],
  onStart,
  onJoin,
  problem,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = place.kind === 'circle' ? (circles.find((circle) => circle.key === place.key) ?? null) : null;
  const joining = place.kind === 'joining' && join ? join : null;
  const elsewhere = circles
    .filter((circle) => circle.key !== current?.key)
    .reduce((total, circle) => total + (unread[circle.key] ?? 0), 0);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (run: () => void) => {
    setOpen(false);
    run();
  };

  return (
    <div className="wb-place" ref={rootRef}>
      <button
        type="button"
        className={`wb-place-button${current ? ' is-circle' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Place: ${current ? current.name : joining ? JOINING_NAME : 'This Mac'}${elsewhere ? `, ${elsewhere} unread elsewhere` : ''}`}
        onClick={() => setOpen((was) => !was)}
      >
        {current ? <CircleTile circle={current} /> : joining ? <JoiningTile /> : <MacTile />}
        <span className="wb-place-copy">
          <b>{current ? current.name : joining ? JOINING_NAME : 'This Mac'}</b>
          <small>{current ? `Circle · ${peopleLine(current)}` : joining ? joiningLine(joining) : MAC_LINE}</small>
        </span>
        {elsewhere ? (
          <span className="wb-rail-count" title="Unread in other places">
            {elsewhere}
          </span>
        ) : null}
        <span className="wb-place-chev" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open ? (
        <div className="wb-place-menu" role="menu" aria-label="Places">
          <button type="button" role="menuitemradio" aria-checked={place.kind === 'mac' || (!current && !joining)} onClick={() => choose(onMac)}>
            <MacTile />
            <span className="wb-place-copy">
              <span>This Mac</span>
              <small>{MAC_LINE}</small>
            </span>
            <span className="wb-place-check" aria-hidden="true">
              {current || joining ? '' : '✓'}
            </span>
          </button>
          {circles.length || join || leaving.length ? <div className="wb-place-menu-head">Circles</div> : null}
          {circles.map((circle) => {
            const count = unread[circle.key] ?? 0;
            const on = current?.key === circle.key;
            return (
              <button
                key={circle.key}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-label={`${circle.name}${count ? `, ${count} unread` : ''}`}
                onClick={() => choose(() => onCircle(circle.key))}
              >
                <CircleTile circle={circle} />
                <span className="wb-place-copy">
                  <span>{circle.name}</span>
                  <small>{peopleLine(circle)}</small>
                </span>
                {count ? <span className="wb-rail-count">{count}</span> : null}
                <span className="wb-place-check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
              </button>
            );
          })}
          {join ? (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={Boolean(joining)}
              aria-label={`${JOINING_NAME} ${joiningLine(join)}`}
              onClick={() => choose(onJoining)}
            >
              <JoiningTile />
              <span className="wb-place-copy">
                <span>{JOINING_NAME}</span>
                <small>{joiningLine(join)}</small>
              </span>
              <span className="wb-place-check" aria-hidden="true">
                {joining ? '✓' : ''}
              </span>
            </button>
          ) : null}
          {leaving.map((left) => (
            <div key={left.key} className="wb-place-menu-static" role="menuitem" aria-disabled="true">
              <JoiningTile />
              <span className="wb-place-copy">
                <span>Leaving {left.name || 'a Circle'}</span>
                <small>Finishes when an admin is online</small>
              </span>
            </div>
          ))}
          {circles.length || join || leaving.length ? null : (
            <p className="wb-place-menu-note">
              A Circle is a small invite-only group. Members’ Macs connect to each other directly and keep its chat.
            </p>
          )}
          {problem ? (
            <p className="wb-place-menu-note is-warn">
              Circles can’t connect: {problem}{' '}
              <button type="button" className="wb-place-menu-link" onClick={() => choose(() => openSettings({ tab: 'general' }))}>
                Circles profile
              </button>
            </p>
          ) : null}
          <hr />
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
