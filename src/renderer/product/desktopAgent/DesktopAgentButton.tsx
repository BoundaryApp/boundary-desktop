import React, { useEffect, useRef, useState } from 'react';
import { ariaShortcut, formatShortcut } from '../../../shared/appCommands';
import { useOwnerDocument } from '../../components/ui/ownerDocument';
import { rendererExperiments } from '../../experiments';
import { useAgentActivity, useBuiltinName } from '../agentButton/agentActivity';
import { AtMark } from '../chat/circle/AtMark';
import { Bubble } from '../chat/ConversationMark';
import { WorkingDot } from '../chat/WorkingDot';
import { useCirclesUnread } from '../circles/useCirclesUnread';
import { isMacPlatform } from '../useAppShortcuts';
import { toggleDesktopPanel, useDesktopPanelOpen, useDesktopPanelTab } from './desktopPanel';
import './desktopAgent.css';

/** Movement under this many pixels is a click, not a drag (agent window spec decision 3). */
const DRAG_THRESHOLD = 4;
/** Half the button's side: the window is the button. */
const HALF = 30;

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  /** Where in the button it was grabbed, from its centre. */
  grabX: number;
  grabY: number;
  moved: boolean;
}

/**
 * The built-in agent's button on the desktop (ADR 0058 §2 to §5), drawn into its own 60-pixel
 * window. A click opens and closes the panel; a drag moves the window and main snaps it to an
 * edge on release. Its menu is the system's, from main.
 */
export const DesktopAgentButton: React.FC = () => {
  const name = useBuiltinName();
  const panelOpen = useDesktopPanelOpen();
  const panelTab = useDesktopPanelTab();
  // A reply is in view once the panel shows the Agent tab, its picker one step away (§4).
  const agentShown = panelOpen && panelTab === 'agent';
  const { running, replied } = useAgentActivity(agentShown);
  const unread = useCirclesUnread();
  const doc = useOwnerDocument();
  const [drag, setDrag] = useState<Drag | null>(null);
  // A drag ends with a click event; this swallows it.
  const dragged = useRef(false);

  useEffect(() => {
    doc.body.classList.add('wb-desktop-button-doc');
    return () => doc.body.classList.remove('wb-desktop-button-doc');
  }, [doc]);

  const centre = (event: React.PointerEvent, at: Drag) => ({
    x: event.screenX - at.grabX,
    y: event.screenY - at.grabY,
  });

  const Figure = rendererExperiments.find((e) => e.BuiltinAgentMark)?.BuiltinAgentMark;
  const isMac = isMacPlatform();
  const label = `Ask ${name}`;
  const unreadLabel = `${unread.total} unread in Circles${unread.mentioned ? ', mentions you' : ''}`;

  return (
    <button
      type="button"
      className={`wb-desktop-button${drag?.moved ? ' is-dragging' : ''}${Figure ? ' has-figure' : ''}`}
      aria-label={label}
      aria-expanded={panelOpen}
      aria-keyshortcuts={ariaShortcut('toggle-agent', isMac)}
      title={`${label}  ${formatShortcut('toggle-agent', isMac)}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragged.current = false;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDrag({
          pointerId: event.pointerId,
          startX: event.screenX,
          startY: event.screenY,
          grabX: event.clientX - HALF,
          grabY: event.clientY - HALF,
          moved: false,
        });
      }}
      onPointerMove={(event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (!drag.moved && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) < DRAG_THRESHOLD) return;
        if (!drag.moved) setDrag({ ...drag, moved: true });
        void window.electronAPI.desktopAgent.drag(centre(event, drag));
      }}
      onPointerUp={(event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.moved) {
          dragged.current = true;
          void window.electronAPI.desktopAgent.drop(centre(event, drag));
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        toggleDesktopPanel();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void window.electronAPI.desktopAgent.contextMenu();
      }}
    >
      <span className="wb-desktop-button-mark" aria-hidden="true">
        {Figure ? <Figure size={48} /> : <Bubble />}
      </span>
      {running ? <WorkingDot label={`${name} is working`} className="wb-desktop-button-badge" /> : null}
      {replied && !running ? <span className="wb-desktop-button-dot" role="img" aria-label={`${name} replied`} /> : null}
      {unread.total ? (
        <span className={`wb-desktop-button-count${unread.mentioned ? ' has-mention' : ''}`} role="img" aria-label={unreadLabel}>
          {unread.mentioned ? <AtMark /> : null}
          {unread.total > 99 ? '99+' : unread.total}
        </span>
      ) : null}
    </button>
  );
};
