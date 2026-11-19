import React, { useEffect, useState } from 'react';
import { isMacPlatform } from '../useAppShortcuts';
import { Button } from '../../components/ui/button';

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock', 'Fn']);

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
};

/** The key a press names: its physical letter or digit, since ⌥ makes `key` a composed character. */
function keyName(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  const physical = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code ?? '');
  if (physical) return physical[1] ?? physical[2];
  return KEY_NAMES[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
}

/** The Electron accelerator for a key press, or null while only modifiers are down. */
export function acceleratorFor(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean
): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const key = keyName(event);
  const parts: string[] = [];
  if (event.metaKey) parts.push(isMac ? 'Command' : 'Super');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return [...parts, key].join('+');
}

const SYMBOLS: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' };

/** An accelerator as the Mac's menus write it: ⌃⌥⇧⌘ then the key. */
export function shortcutLabel(accelerator: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const order = ['Control', 'Alt', 'Shift', 'Command', 'Super'];
  const modifiers = order.filter((name) => parts.includes(name)).map((name) => SYMBOLS[name]);
  return [...new Set(modifiers)].join('') + key;
}

/**
 * **Shortcut from any app** (ADR 0058 §11): none until the user records one. Main refuses ⌘J,
 * a key with no modifier, and one another app holds, and the reason shows here.
 */
export const PanelShortcutField: React.FC<{ shortcut: string | null }> = ({ shortcut }) => {
  const [saved, setSaved] = useState(shortcut);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSaved(shortcut), [shortcut]);

  const save = async (accelerator: string | null) => {
    setError(null);
    const result = await window.electronAPI.desktopAgent.setShortcut(accelerator);
    if (result.success) setSaved(accelerator);
    else {
      setSaved(null);
      setError(result.error ?? 'That shortcut can’t be used.');
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }
    const accelerator = acceleratorFor(event.nativeEvent, isMacPlatform());
    if (!accelerator) return;
    setRecording(false);
    void save(accelerator);
  };

  return (
    <div className="wb-shortcut-field">
      <span className="wb-shortcut-value">{saved ? <kbd>{shortcutLabel(saved)}</kbd> : 'None'}</span>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={() => {
          setError(null);
          setRecording(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
      >
        {recording ? 'Press a shortcut…' : 'Record shortcut'}
      </Button>
      {saved ? (
        <Button variant="secondary" size="sm" type="button" onClick={() => void save(null)}>
          Clear
        </Button>
      ) : null}
      {error ? (
        <p className="wb-shortcut-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};
