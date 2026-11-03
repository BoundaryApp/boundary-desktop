import React, { useEffect, useRef, useState } from 'react';
import type { CircleSnapshot } from '../../../../shared/types/circles';
import type { ChatPlace } from '../circlePlace';
import { keyHue } from '../../circles/CircleControls';
import { peopleLine } from './peopleLine';
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

const MAC_LINE = 'Projects, Hermes, your agents';

export interface PlaceSwitcherProps {
  place: ChatPlace;
  circles: CircleSnapshot[];
  /** Unread messages by Circle key. */
  unread: Record<string, number>;
  onMac: () => void;
  onCircle: (key: string) => void;
  /** Start or join a Circle, or manage one: the Circles screen until it is retired (ADR 0043). */
  onManage: () => void;
}

/**
 * The top of the chat rail: which place the rail shows, This Mac or one Circle, and a menu to
 * switch (Circle chats spec decision 1). It carries the unread total of the other places.
 */
export const PlaceSwitcher: React.FC<PlaceSwitcherProps> = ({ place, circles, unread, onMac, onCircle, onManage }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = place.kind === 'circle' ? (circles.find((circle) => circle.key === place.key) ?? null) : null;
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
        aria-label={`Place: ${current ? current.name : 'This Mac'}${elsewhere ? `, ${elsewhere} unread elsewhere` : ''}`}
        onClick={() => setOpen((was) => !was)}
      >
        {current ? <CircleTile circle={current} /> : <MacTile />}
        <span className="wb-place-copy">
          <b>{current ? current.name : 'This Mac'}</b>
          <small>{current ? `Circle · ${peopleLine(current)}` : MAC_LINE}</small>
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
          <button type="button" role="menuitemradio" aria-checked={!current} onClick={() => choose(onMac)}>
            <MacTile />
            <span className="wb-place-copy">
              <span>This Mac</span>
              <small>{MAC_LINE}</small>
            </span>
            <span className="wb-place-check" aria-hidden="true">
              {current ? '' : '✓'}
            </span>
          </button>
          {circles.length ? <div className="wb-place-menu-head">Circles</div> : null}
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
          <hr />
          <button type="button" role="menuitem" onClick={() => choose(onManage)}>
            Start or join a Circle…
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onManage)}>
            Manage Circles…
          </button>
        </div>
      ) : null}
    </div>
  );
};
