/** App-level commands shared by the menu bar (main) and keyboard shortcuts (renderer). */
export const APP_MENU_COMMAND_CHANNEL = 'app:menu-command';

export type AppCommand =
  | 'new-chat'
  | 'go-chat'
  | 'go-services'
  | 'go-resources'
  | 'go-circles'
  | 'go-settings'
  | 'prev-thread'
  | 'next-thread';

export interface AppCommandDefinition {
  id: AppCommand;
  label: string;
  /** Electron accelerator; the renderer matches the same keys. */
  accelerator: string;
}

export const APP_COMMANDS: AppCommandDefinition[] = [
  { id: 'new-chat', label: 'New Chat', accelerator: 'CmdOrCtrl+N' },
  { id: 'go-chat', label: 'Chat', accelerator: 'CmdOrCtrl+1' },
  { id: 'go-services', label: 'Services', accelerator: 'CmdOrCtrl+2' },
  { id: 'go-resources', label: 'Resources', accelerator: 'CmdOrCtrl+3' },
  { id: 'go-circles', label: 'Circles', accelerator: 'CmdOrCtrl+4' },
  { id: 'go-settings', label: 'Settings', accelerator: 'CmdOrCtrl+,' },
  { id: 'prev-thread', label: 'Previous Conversation', accelerator: 'CmdOrCtrl+[' },
  { id: 'next-thread', label: 'Next Conversation', accelerator: 'CmdOrCtrl+]' },
];

/** Human label for a command's shortcut, e.g. "⌘N" on macOS, "Ctrl+N" elsewhere. */
export function formatShortcut(id: AppCommand, isMac: boolean): string {
  const def = APP_COMMANDS.find((command) => command.id === id);
  if (!def) return '';
  const key = def.accelerator.replace('CmdOrCtrl+', '');
  return isMac ? `⌘${key}` : `Ctrl+${key}`;
}
