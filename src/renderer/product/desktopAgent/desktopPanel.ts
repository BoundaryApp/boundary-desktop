import { createStoredValue, createValueStore } from '../../lib/valueStore';

/** Whether the desktop panel is open (ADR 0058 §6, §9). The button, ⌘J and the panel's × toggle it. */
const panelOpen = createValueStore(false);

export const useDesktopPanelOpen = (): boolean => panelOpen.use();
export const setDesktopPanelOpen = (next: boolean): void => panelOpen.set(next);
export const toggleDesktopPanel = (): void => panelOpen.set(!panelOpen.get());

export type DesktopPanelTab = 'agent' | 'circles';

/** The panel opens on the tab last used, kept on this Mac (§6). */
const panelTab = createStoredValue<DesktopPanelTab>(
  'boundary:agent-panel-tab',
  'agent',
  (value): value is DesktopPanelTab => value === 'agent' || value === 'circles'
);

export const useDesktopPanelTab = (): DesktopPanelTab => panelTab.use();
export const setDesktopPanelTab = (next: DesktopPanelTab): void => panelTab.set(next);

/** The Circle the Circles tab shows, or null for the list (§8). Kept on this Mac. */
const panelCircle = createStoredValue<string | null>(
  'boundary:agent-panel-circle',
  null,
  (value): value is string | null => value === null || typeof value === 'string'
);

export const usePanelCircle = (): string | null => panelCircle.use();
export const setPanelCircle = (key: string | null): void => panelCircle.set(key);
export const panelCircleNow = (): string | null => panelCircle.get();

/** Bring Boundary's window forward and close the panel: ⤢, and links to what only the app shows (§10). */
export function leavePanelForWindow(): void {
  void window.electronAPI.desktopAgent.showWindow();
  panelOpen.set(false);
}

export const resetDesktopPanelForTests = (): void => {
  panelOpen.reset();
  panelTab.reset();
  panelCircle.reset();
};
