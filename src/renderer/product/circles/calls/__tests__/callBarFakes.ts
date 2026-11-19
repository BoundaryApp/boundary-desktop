import { vi } from 'vitest';
import type { CallParticipant } from '../../../../../shared/calls/callSession';
import type { Call } from '../callService';

export const ME = 'a1'.repeat(32);
export const SAM = 'c3'.repeat(32);
export const CIRCLE = 'cc'.repeat(32);

const connected = (identity: string): CallParticipant => ({
  key: `${identity}/0123456789abcdef`,
  identity,
  s: '0123456789abcdef',
  muted: false,
  camera: false,
  state: 'connected',
  remote: new MediaStream(),
});

/** A call with one person, with every method a spy. */
export function personCall(overrides: Partial<Call> = {}): Call {
  return {
    circleKey: CIRCLE,
    room: 'p-1',
    me: ME,
    with: SAM,
    dial: 'answered',
    connectedAt: Date.now(),
    participants: [connected(SAM)],
    localStream: new MediaStream(),
    muted: false,
    camera: false,
    mute: vi.fn(),
    setCamera: vi.fn(async () => undefined),
    setDevice: vi.fn(async () => undefined),
    retry: vi.fn(),
    leave: vi.fn(),
    onChange: () => () => undefined,
    ...overrides,
  };
}
