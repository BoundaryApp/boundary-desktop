import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppCommand } from '../../../shared/appCommands';
import { formatShortcut } from '../../../shared/appCommands';
import {
  dispatchAppCommand,
  matchShortcut,
  useAppCommand,
  useAppShortcuts,
} from '../useAppShortcuts';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('matchShortcut', () => {
  it('maps ⌘ keys on macOS and Ctrl keys elsewhere', () => {
    expect(matchShortcut(key({ key: 'n', metaKey: true }), true)).toBe('new-chat');
    expect(matchShortcut(key({ key: '2', metaKey: true }), true)).toBe('go-circles');
    expect(matchShortcut(key({ key: '3', metaKey: true }), true)).toBe('go-inference');
    expect(matchShortcut(key({ key: '5', metaKey: true }), true)).toBe('go-resources');
    expect(matchShortcut(key({ key: ',', metaKey: true }), true)).toBe('go-settings');
    expect(matchShortcut(key({ key: ']', ctrlKey: true }), false)).toBe('next-thread');
    expect(matchShortcut(key({ key: 'n', ctrlKey: true }), true)).toBeNull();
  });

  it('maps exactly these ⌘ keys', () => {
    const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789,.;/[]\\-=`\''];
    const mapped = Object.fromEntries(
      keys.flatMap((k) => {
        const command = matchShortcut(key({ key: k, metaKey: true }), true);
        return command ? [[k, command]] : [];
      })
    );
    expect(mapped).toEqual({
      n: 'new-chat',
      j: 'toggle-agent',
      '1': 'go-chat',
      '2': 'go-circles',
      '3': 'go-inference',
      '4': 'go-services',
      '5': 'go-resources',
      ',': 'go-settings',
      '[': 'prev-thread',
      ']': 'next-thread',
    });
    expect(matchShortcut(key({ key: 'N', metaKey: true }), true)).toBe('new-chat');
  });

  it('ignores shifted, alt, and unmodified keys', () => {
    expect(matchShortcut(key({ key: 'n', metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: 'n', metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: 'n' }), true)).toBeNull();
  });

  it('maps ⌥⌘0 / Ctrl+Alt+0 to the inspector by physical key, since Option changes the character', () => {
    expect(matchShortcut(key({ key: 'º', code: 'Digit0', metaKey: true, altKey: true }), true)).toBe(
      'toggle-inspector'
    );
    expect(matchShortcut(key({ key: '0', code: 'Digit0', ctrlKey: true, altKey: true }), false)).toBe(
      'toggle-inspector'
    );
    expect(matchShortcut(key({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), true)).toBeNull();
    expect(formatShortcut('toggle-inspector', true)).toBe('⌥⌘0');
    expect(formatShortcut('toggle-inspector', false)).toBe('Ctrl+Alt+0');
  });

  it('formats shortcut labels per platform', () => {
    expect(formatShortcut('go-chat', true)).toBe('⌘1');
    expect(formatShortcut('new-chat', false)).toBe('Ctrl+N');
  });
});

describe('app command hooks', () => {
  it('delivers keyboard shortcuts and dispatched commands to subscribers', () => {
    const received: AppCommand[] = [];
    const Probe = (): null => {
      useAppShortcuts();
      useAppCommand((command) => received.push(command));
      return null;
    };
    render(<Probe />);
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    dispatchAppCommand('prev-thread');
    expect(received).toEqual(['go-inference', 'prev-thread']);
  });
});
