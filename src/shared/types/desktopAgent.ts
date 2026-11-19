/** The window names the app's page opens the desktop button and panel under (ADR 0058). */
export const DESKTOP_BUTTON_WINDOW = 'boundary-agent-button';
export const DESKTOP_PANEL_WINDOW = 'boundary-agent-panel';

/** Where the desktop button sits (ADR 0058 §5): a display, an edge of its work area, and a place along it from 0 to 1. */
export interface DesktopAgentSpot {
  displayId: number;
  edge: 'top' | 'right' | 'bottom' | 'left';
  along: number;
}

/** The agent button's corners, by the name its menu shows: an edge and the end of it (ADR 0052 §9, 0058 §5). */
export const AGENT_BUTTON_CORNERS = {
  'Bottom right': { edge: 'bottom', along: 1 },
  'Bottom left': { edge: 'bottom', along: 0 },
  'Top right': { edge: 'top', along: 1 },
  'Top left': { edge: 'top', along: 0 },
} as const satisfies Record<string, Pick<DesktopAgentSpot, 'edge' | 'along'>>;

export type AgentButtonCorner = keyof typeof AGENT_BUTTON_CORNERS;
