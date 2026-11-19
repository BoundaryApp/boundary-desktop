import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import '../chat/circle/circleChat.css';
import { PlacedCallBar } from './calls/PlacedCallBar';
import { AREA_MIN_PX, DOCK_MIN_PX, ROW_PX, clampDockHeight, dockRowCount, readDockHeight, saveDockHeight } from './dockHeight';

export interface CirclesRailProps {
  /** The open Circle's header and sections, or null when no Circle is open. */
  area: React.ReactNode | null;
  /** Every Circle, listed by name. */
  dock: React.ReactNode;
}

/**
 * The height the Circle area and the dock share, kept current as the window changes: the rail's
 * height less the titlebar spacer above them. Null until the first measure.
 */
function useRailHeight(ref: React.RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  // Measured before paint, so the dock never shows at a height clamped against an unmeasured rail.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const spacer = element.querySelector('.wb-titlebar-spacer');
    const measure = () => setHeight(element.getBoundingClientRect().height - (spacer?.getBoundingClientRect().height ?? 0));
    measure();
    // The observer catches changes that are not the window's; the window event covers the rest.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return height;
}

/**
 * The Circles rail (Circles screen spec decision 22): the open Circle's area on top, which
 * scrolls on its own, and below it a grip and the dock of every Circle. The dock's height is
 * the person's choice, kept on this Mac, and gives way in a window too short for both parts.
 * With no Circle area the dock takes the whole rail. The call bar, during a call, sits at the foot.
 */
export const CirclesRail: React.FC<CirclesRailProps> = ({ area, dock }) => {
  const railRef = useRef<HTMLElement>(null);
  const dockId = useId();
  const railPx = useRailHeight(railRef);
  // The wanted height is only changed by the person, so a short window never overwrites it.
  const [wanted, setWanted] = useState(readDockHeight);
  // `chosen` stays null until the pointer moves, so a plain click never saves.
  const drag = useRef<{ startY: number; startHeight: number; chosen: number | null } | null>(null);

  // An unmeasured rail is unconstrained.
  const shown = railPx === null ? wanted : clampDockHeight(wanted, railPx);
  const max = railPx === null ? wanted : Math.max(DOCK_MIN_PX, railPx - AREA_MIN_PX);

  const choose = (px: number) => {
    const next = railPx === null ? px : clampDockHeight(px, railPx);
    setWanted(next);
    return next;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: event.clientY, startHeight: shown, chosen: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current.chosen = choose(drag.current.startHeight + drag.current.startY - event.clientY);
  };
  const endDrag = () => {
    const finished = drag.current;
    drag.current = null;
    if (finished?.chosen != null) saveDockHeight(finished.chosen);
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target =
      event.key === 'ArrowUp'
        ? shown + ROW_PX
        : event.key === 'ArrowDown'
          ? shown - ROW_PX
          : event.key === 'Home'
            ? DOCK_MIN_PX
            : event.key === 'End'
              ? max
              : null;
    if (target === null) return;
    event.preventDefault();
    // At a limit nothing changes, so the stored height is left as the person set it.
    const next = railPx === null ? target : clampDockHeight(target, railPx);
    if (next === shown) return;
    setWanted(next);
    saveDockHeight(next);
  };

  return (
    <aside ref={railRef} className="wb-left wb-circle-rail" aria-label="Circles">
      <div className="wb-titlebar-spacer" aria-hidden="true" />
      {area !== null ? <div className="wb-circle-area">{area}</div> : null}
      {area !== null ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Circle list"
          aria-valuenow={shown}
          aria-valuemin={DOCK_MIN_PX}
          aria-valuemax={max}
          aria-valuetext={`${dockRowCount(shown)} rows`}
          aria-controls={dockId}
          tabIndex={0}
          className="wb-circles-grip"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        />
      ) : null}
      <div
        id={dockId}
        className={`wb-circles-dock${area !== null ? '' : ' is-alone'}`}
        style={area !== null ? { height: shown } : undefined}
      >
        {dock}
      </div>
      <PlacedCallBar />
    </aside>
  );
};
