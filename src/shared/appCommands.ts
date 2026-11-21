/** App-level commands shared by the menu bar (main) and keyboard shortcuts (renderer). */

export type AppCommand =
  | 'new-chat'
  | 'toggle-agent'
  | 'go-chat'
  | 'go-circles'
  | 'go-inference'
  | 'go-services'
  | 'go-resources'
  | 'go-settings'
  | 'prev-thread'
  | 'next-thread'
  | 'report-bug'
  | 'toggle-inspector';

export interface AppCommandDefinition {
  id: AppCommand;
  label: string;
  /** Electron accelerator; the renderer matches the same keys. */
  accelerator: string;
}

export const APP_COMMANDS: AppCommandDefinition[] = [
  { id: 'new-chat', label: 'New Chat', accelerator: 'CmdOrCtrl+N' },
  { id: 'toggle-agent', label: 'Ask Your Agent', accelerator: 'CmdOrCtrl+J' },
  { id: 'go-chat', label: 'Chat', accelerator: 'CmdOrCtrl+1' },
  { id: 'go-circles', label: 'Circles', accelerator: 'CmdOrCtrl+2' },
  { id: 'go-inference', label: 'Inference', accelerator: 'CmdOrCtrl+3' },
  { id: 'go-services', label: 'Services', accelerator: 'CmdOrCtrl+4' },
  { id: 'go-resources', label: 'Resources', accelerator: 'CmdOrCtrl+5' },
  { id: 'go-settings', label: 'Settings', accelerator: 'CmdOrCtrl+,' },
  { id: 'prev-thread', label: 'Previous Conversation', accelerator: 'CmdOrCtrl+[' },
  { id: 'next-thread', label: 'Next Conversation', accelerator: 'CmdOrCtrl+]' },
  { id: 'report-bug', label: 'Report a Bug…', accelerator: 'CmdOrCtrl+Shift+B' },
  // ⌥⌘I is Toggle Developer Tools in the View menu (ADR 0069 §1).
  { id: 'toggle-inspector', label: 'Toggle Details', accelerator: 'CmdOrCtrl+Alt+0' },
];

/** Human label for a command's shortcut, e.g. "⌘N", "⇧⌘B" or "⌥⌘0" on macOS, "Ctrl+Shift+B" elsewhere. */
export function formatShortcut(id: AppCommand, isMac: boolean): string {
  const def = APP_COMMANDS.find((command) => command.id === id);
  if (!def) return '';
  const parts = def.accelerator.split('+');
  const key = parts[parts.length - 1];
  const shift = parts.includes('Shift');
  const alt = parts.includes('Alt');
  if (isMac) return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘${key}`;
  return `Ctrl+${alt ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${key}`;
}

/** The shortcut in `aria-keyshortcuts` form, e.g. "Meta+Shift+B". */
export function ariaShortcut(id: AppCommand, isMac: boolean): string {
  const def = APP_COMMANDS.find((command) => command.id === id);
  if (!def) return '';
  return def.accelerator.replace('CmdOrCtrl', isMac ? 'Meta' : 'Control');
}
