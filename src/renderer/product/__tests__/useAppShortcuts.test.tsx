import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(matchShortcut(key({ key: '2', metaKey: true }), true)).toBe('go-services');
    expect(matchShortcut(key({ key: ',', metaKey: true }), true)).toBe('go-settings');
    expect(matchShortcut(key({ key: ']', ctrlKey: true }), false)).toBe('next-thread');
    expect(matchShortcut(key({ key: 'n', ctrlKey: true }), true)).toBeNull();
  });

  it('ignores shifted, alt, and unmodified keys', () => {
    expect(matchShortcut(key({ key: 'n', metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: 'n', metaKey: true, altKey: true }), true)).toBeNull();
    expect(matchShortcut(key({ key: 'n' }), true)).toBeNull();
  });

  it('formats shortcut labels per platform', () => {
    expect(formatShortcut('go-chat', true)).toBe('⌘1');
    expect(formatShortcut('new-chat', false)).toBe('Ctrl+N');
  });
});

describe('app command hooks', () => {
  afterEach(() => cleanup());

  it('delivers keyboard shortcuts and dispatched commands to subscribers', () => {
    const received: AppCommand[] = [];
    const Probe = () => {
      useAppShortcuts();
      useAppCommand((command) => received.push(command));
      return null;
    };
    render(<Probe />);
    fireEvent.keyDown(window, { key: '3', ctrlKey: true });
    dispatchAppCommand('prev-thread');
    expect(received).toEqual(['go-resources', 'prev-thread']);
  });
});
