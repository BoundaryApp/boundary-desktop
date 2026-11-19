import React, { useEffect, useRef, useState } from 'react';
import { useAgentActivity, useBuiltinName } from './agentActivity';
import { ariaShortcut, formatShortcut } from '../../../shared/appCommands';
import { useDismiss } from '../../components/ui/use-dismiss';
import { rendererExperiments } from '../../experiments';
import { Bubble } from '../chat/ConversationMark';
import { WorkingDot } from '../chat/WorkingDot';
import { isMacPlatform, useAppCommand } from '../useAppShortcuts';
import {
  BUTTON_SIZE,
  CORNERS,
  nearestSpot,
  saveAgentButtonSpot,
  spotStyle,
  useAgentButtonSpot,
  type AgentButtonEdge,
} from './agentButtonSpot';
import './agentButton.css';

/** Movement under this many pixels is a click, not a drag (spec decision 3). */
const DRAG_THRESHOLD = 4;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** The centre while dragging, relative to the content area; null until past the threshold. */
  at: { x: number; y: number } | null;
}

/**
 * The built-in agent over every screen but Chat (ADR 0052 §7, agent window spec decisions 1 to 4):
 * a button with the agent's chat mark in the content area's corner. It sits under sheets and
 * menus. Until the floating window lands (spec phase 3), pressing it or ⌘J opens Chat.
 */
export const AgentButton: React.FC<{ hidden: boolean; onOpen: () => void }> = ({ hidden, onOpen }) => {
  const spot = useAgentButtonSpot();
  const name = useBuiltinName();
  const { running, replied, clear } = useAgentActivity(hidden);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // A drag ends with a click event; this swallows it.
  const dragged = useRef(false);

  const open = (): void => {
    clear();
    onOpen();
  };

  useAppCommand((command) => {
    if (command === 'toggle-agent' && !hidden) open();
  });

  useDismiss(menuRef, menu, () => setMenu(false), { returnFocusTo: buttonRef });
  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [menu]);

  if (hidden) return null;

  // The button is placed in its parent, the positioned content area.
  const area = (): DOMRect | null => buttonRef.current?.parentElement?.getBoundingClientRect() ?? null;

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, at: null });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.at && moved < DRAG_THRESHOLD) return;
    const rect = area();
    if (!rect) return;
    setDrag({ ...drag, at: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = area();
    if (drag.at && rect) {
      dragged.current = true;
      saveAgentButtonSpot(nearestSpot(drag.at.x, drag.at.y, rect.width, rect.height));
    }
    setDrag(null);
  };

  const target = drag?.at && area() ? nearestSpot(drag.at.x, drag.at.y, area()!.width, area()!.height).edge : null;
  const Figure = rendererExperiments.find((e) => e.BuiltinAgentMark)?.BuiltinAgentMark;
  const isMac = isMacPlatform();
  const label = `Ask ${name}`;
  const style = drag?.at
    ? { left: `${drag.at.x - BUTTON_SIZE / 2}px`, top: `${drag.at.y - BUTTON_SIZE / 2}px` }
    : spotStyle(spot);

  return (
    <>
      {drag?.at ? <DragGuides target={target} /> : null}
      <button
        ref={buttonRef}
        type="button"
        className={`wb-agent-button${drag?.at ? ' is-dragging' : ''}${Figure ? ' has-figure' : ''}`}
        style={style}
        aria-label={label}
        aria-keyshortcuts={ariaShortcut('toggle-agent', isMac)}
        title={`${label}  ${formatShortcut('toggle-agent', isMac)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          open();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu(true);
        }}
      >
        <span className="wb-agent-button-mark" aria-hidden="true">
          {Figure ? <Figure size={48} /> : <Bubble />}
        </span>
        {running ? <WorkingDot label={`${name} is working`} className="wb-agent-button-badge" /> : null}
        {replied && !running ? <span className="wb-agent-button-dot" role="img" aria-label={`${name} replied`} /> : null}
      </button>
      {menu ? (
        <div ref={menuRef} className="wb-agent-button-menu" style={menuStyle(spot.edge, spot.along)} role="menu" aria-label="Move the agent button">
          {Object.entries(CORNERS).map(([corner, at]) => (
            <button
              key={corner}
              type="button"
              role="menuitem"
              onClick={() => {
                saveAgentButtonSpot(at);
                setMenu(false);
                buttonRef.current?.focus();
              }}
            >
              {corner}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
};

/** The corner slots and the edge the button will snap to, shown while it's dragged. */
const DragGuides: React.FC<{ target: AgentButtonEdge | null }> = ({ target }) => (
  <div className="wb-agent-guides" aria-hidden="true">
    {Object.entries(CORNERS).map(([corner, at]) => (
      <span key={corner} className="wb-agent-slot" style={spotStyle(at)} />
    ))}
    {target ? <span className={`wb-agent-edge is-${target}`} /> : null}
  </div>
);

/** The corner menu opens beside the button, toward the middle of the content area. */
function menuStyle(edge: AgentButtonEdge, along: number): Record<string, string> {
  const base = spotStyle({ edge, along });
  const gap = `${BUTTON_SIZE + 8}px`;
  // Past the middle, the menu lines up with the button's far side so it stays on screen.
  const flip = along > 0.5;
  if (edge === 'bottom' || edge === 'top') {
    const away = edge === 'bottom' ? { bottom: `calc(${base.bottom} + ${gap})` } : { top: `calc(${base.top} + ${gap})` };
    return { ...base, ...away, ...(flip ? { transform: `translateX(calc(-100% + ${BUTTON_SIZE}px))` } : {}) };
  }
  const away = edge === 'left' ? { left: `calc(${base.left} + ${gap})` } : { right: `calc(${base.right} + ${gap})` };
  return { ...base, ...away, ...(flip ? { transform: `translateY(calc(-100% + ${BUTTON_SIZE}px))` } : {}) };
}
