import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPanelShortcut,
  initPanelShortcut,
  panelShortcutError,
  registerPanelShortcut,
  resetPanelShortcutForTests,
} from '../panelShortcut';

let held: Map<string, () => void>;
let taken: Set<string>;
const onPress = vi.fn();

beforeEach(() => {
  held = new Map();
  taken = new Set(['Alt+Space']);
  onPress.mockReset();
  initPanelShortcut({
    api: {
      register: (accelerator, callback) => {
        if (taken.has(accelerator)) return false;
        held.set(accelerator, callback);
        return true;
      },
      unregister: (accelerator) => {
        held.delete(accelerator);
      },
    },
    onPress,
  });
});
afterEach(() => resetPanelShortcutForTests());

describe('the panel shortcut from any app (ADR 0058 §11)', () => {
  it('holds none until one is set', () => {
    expect(held.size).toBe(0);
  });

  it('registers one that opens the panel, and swaps it for the next', () => {
    expect(registerPanelShortcut('Control+Alt+B')).toEqual({ ok: true });
    held.get('Control+Alt+B')!();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(registerPanelShortcut('Control+Alt+K')).toEqual({ ok: true });
    expect([...held.keys()]).toEqual(['Control+Alt+K']);
  });

  it.each(['CmdOrCtrl+J', 'Command+J', 'Cmd+J', 'CommandOrControl+j'])('refuses %s, which other apps use', (accelerator) => {
    const result = registerPanelShortcut(accelerator);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/⌘J/);
    expect(held.size).toBe(0);
  });

  it('refuses a key with no modifier', () => {
    expect(registerPanelShortcut('B').ok).toBe(false);
  });

  // Review: Shift+A held globally would swallow every capital A typed in every app.
  it('refuses Shift alone, which would take typed capitals from every app', () => {
    expect(registerPanelShortcut('Shift+A').ok).toBe(false);
    expect(held.size).toBe(0);
    expect(registerPanelShortcut('Shift+Alt+A')).toEqual({ ok: true });
  });

  it('reports a shortcut another app holds and keeps none', () => {
    registerPanelShortcut('Control+Alt+B');
    const result = registerPanelShortcut('Alt+Space');
    expect(result).toEqual({ ok: false, error: 'Another app is using that shortcut.' });
    expect(held.size).toBe(0);
  });

  it('lets go of it on null', () => {
    registerPanelShortcut('Control+Alt+B');
    expect(registerPanelShortcut(null)).toEqual({ ok: true });
    expect(held.size).toBe(0);
  });

  it('checks a shortcut without registering it', () => {
    expect(panelShortcutError('Cmd+J')).toMatch(/⌘J/);
    expect(panelShortcutError('Control+Alt+B')).toBeNull();
    expect(held.size).toBe(0);
  });

  it('holds the stored shortcut while the switch is on and lets go when it goes off', () => {
    applyPanelShortcut(true, 'Control+Alt+B');
    expect([...held.keys()]).toEqual(['Control+Alt+B']);
    applyPanelShortcut(false, 'Control+Alt+B');
    expect(held.size).toBe(0);
  });

  it('holds nothing for a stored value that isn’t a shortcut', () => {
    applyPanelShortcut(true, undefined);
    applyPanelShortcut(true, 42);
    expect(held.size).toBe(0);
  });
});
