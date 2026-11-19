import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installElectronAPI, stubElectronAPI } from '../../../__tests__/electronApiFake';
import { reportViewing, resetCircleViewingForTests } from '../circleViewingRegistry';

let viewing: ReturnType<typeof vi.fn>;
const garden = (channel: string, focused: boolean) => ({ circleKey: 'c1', channel, focused });

beforeEach(() => {
  installElectronAPI();
  viewing = vi.fn().mockResolvedValue(undefined);
  stubElectronAPI({ circles: { viewing } });
  resetCircleViewingForTests();
});
afterEach(() => resetCircleViewingForTests());

const last = () => viewing.mock.calls.at(-1)?.[0];

describe('which Circle channel main hears is on screen (ADR 0058 §8)', () => {
  it('sends the focused panel over an unfocused window', () => {
    reportViewing('window', garden('general', false));
    reportViewing('panel', garden('garden', true));
    expect(last()).toEqual(garden('garden', true));
  });

  it('sends the focused window over an unfocused panel', () => {
    reportViewing('panel', garden('garden', false));
    reportViewing('window', garden('general', true));
    expect(last()).toEqual(garden('general', true));
  });

  it('falls back to the window when the panel blurs', () => {
    reportViewing('window', garden('general', false));
    reportViewing('panel', garden('garden', true));
    reportViewing('panel', garden('garden', false));
    expect(last()).toEqual(garden('general', false));
  });

  it('falls back to the window when the panel stops showing a channel', () => {
    reportViewing('window', garden('general', false));
    reportViewing('panel', garden('garden', true));
    reportViewing('panel', null);
    expect(last()).toEqual(garden('general', false));
  });

  it('sends null when neither shows a channel', () => {
    reportViewing('window', garden('general', true));
    reportViewing('window', null);
    expect(last()).toBeNull();
  });
});
