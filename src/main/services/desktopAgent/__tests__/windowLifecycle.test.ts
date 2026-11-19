import { describe, expect, it } from 'vitest';
import { shouldHideOnClose } from '../windowLifecycle';

const closing = { switchOn: true, platform: 'darwin' as NodeJS.Platform, quitting: false, installingUpdate: false };

describe('shouldHideOnClose (ADR 0058 §1)', () => {
  it('hides on close when the switch is on', () => {
    expect(shouldHideOnClose(closing)).toBe(true);
  });

  it('closes when the switch is off', () => {
    expect(shouldHideOnClose({ ...closing, switchOn: false })).toBe(false);
  });

  it('closes while quitting', () => {
    expect(shouldHideOnClose({ ...closing, quitting: true })).toBe(false);
  });

  it('closes while an update installs', () => {
    expect(shouldHideOnClose({ ...closing, installingUpdate: true })).toBe(false);
  });

  it.each(['linux', 'win32'] as const)('closes on %s', (platform) => {
    expect(shouldHideOnClose({ ...closing, platform })).toBe(false);
  });
});
