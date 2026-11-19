/**
 * A shortcut that opens and closes the desktop panel from any app (ADR 0058 §11). Off until the
 * user sets one in Settings, and never ⌘J, which other apps use. It holds only while the
 * desktop button is on.
 */

/** The part of Electron's `globalShortcut` this uses. */
interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface PanelShortcutDeps {
  api: ShortcutApi;
  onPress: () => void;
}

let deps: PanelShortcutDeps | null = null;
let held: string | null = null;

export function initPanelShortcut(next: PanelShortcutDeps): void {
  deps = next;
}

const COMMAND = new Set(['cmd', 'command', 'cmdorctrl', 'commandorcontrol', 'super', 'meta']);
const MODIFIERS = new Set([...COMMAND, 'ctrl', 'control', 'alt', 'option', 'altgr', 'shift']);

/** Why `accelerator` can't be the panel's shortcut, or null when it can. */
export function panelShortcutError(accelerator: string): string | null {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1);
  // Shift alone would take typed capitals from every app.
  if (!key || !modifiers.some((part) => part !== 'shift') || modifiers.some((part) => !MODIFIERS.has(part))) {
    return 'Use a key with ⌘, ⌃ or ⌥.';
  }
  if (key === 'j' && modifiers.length === 1 && COMMAND.has(modifiers[0])) {
    return 'Other apps use ⌘J. Choose another shortcut.';
  }
  return null;
}

/**
 * Hold `accelerator` for the panel, letting go of the one held before. Null lets go. When another
 * app holds it, none is held.
 */
export function registerPanelShortcut(accelerator: string | null): { ok: boolean; error?: string } {
  if (held) deps?.api.unregister(held);
  held = null;
  if (accelerator === null) return { ok: true };
  const error = panelShortcutError(accelerator);
  if (error) return { ok: false, error };
  if (!deps) return { ok: false, error: 'Shortcuts aren’t ready yet.' };
  const onPress = deps.onPress;
  if (!deps.api.register(accelerator, () => onPress())) {
    return { ok: false, error: 'Another app is using that shortcut.' };
  }
  held = accelerator;
  return { ok: true };
}

export function resetPanelShortcutForTests(): void {
  deps = null;
  held = null;
}

/** The stored shortcut held while the switch is on, and none while it is off. */
export function applyPanelShortcut(on: boolean, stored: unknown): { ok: boolean; error?: string } {
  return registerPanelShortcut(on && typeof stored === 'string' && stored ? stored : null);
}
