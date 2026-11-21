import React, { createContext, useContext } from 'react';
import { ariaShortcut, formatShortcut } from '../../../shared/appCommands';
import { isMacPlatform } from '../useAppShortcuts';
import { Button } from '../../components/ui/button';
import type { InspectorTab } from './inspectorTabs';

/** What the center pane's headers need to draw the inspector toggle (ADR 0069 §1, §4). */
export interface InspectorToggleState {
  open: boolean;
  /** The Project tab's worst banner, for the dot and the tooltip; null when there is none. */
  warning: string | null;
  toggle: () => void;
  /** Opens the inspector on a tab, for controls such as the channel members button. */
  openAt: (tab?: InspectorTab) => void;
}

const InspectorToggleContext = createContext<InspectorToggleState | null>(null);

export const InspectorToggleProvider = InspectorToggleContext.Provider;

/** The toggle's state, or null outside the chat screen or where the inspector is left out. */
export function useInspectorToggle(): InspectorToggleState | null {
  return useContext(InspectorToggleContext);
}

/**
 * The inspector toggle, at the right end of a center pane header. Draws nothing outside the chat
 * screen (the agent panel) or where the screen leaves the inspector out (the Tasks board).
 */
export const InspectorToggle: React.FC = () => {
  const state = useInspectorToggle();
  if (!state) return null;
  const isMac = isMacPlatform();
  const shortcut = formatShortcut('toggle-inspector', isMac);
  const action = state.open ? 'Hide details' : 'Show details';
  const label = state.warning ? `${action}: ${state.warning}` : action;
  return (
    <Button
      variant="quiet"
      size="icon-sm"
      type="button"
      className={`wb-insp-toggle${state.open ? ' is-on' : ''}`}
      aria-label={label}
      aria-keyshortcuts={ariaShortcut('toggle-inspector', isMac)}
      title={`${label}  ${shortcut}`}
      onClick={state.toggle}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
        <path d="M10 2.5v11" />
      </svg>
      {state.warning ? <span className="wb-insp-toggle-dot" aria-hidden="true" /> : null}
    </Button>
  );
};
