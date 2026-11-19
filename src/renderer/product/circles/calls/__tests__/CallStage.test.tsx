import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallParticipant } from '../../../../../shared/calls/callSession';
import { watchLevel } from '../audioLevel';
import { CallStage } from '../CallStage';
import type { Call } from '../callService';

vi.mock('../audioLevel', () => ({ watchLevel: vi.fn((): (() => void) => () => undefined) }));

const ME = 'a1'.repeat(32);
const MAYA = 'b2'.repeat(32);
const SAM = 'c3'.repeat(32);

const person = (identity: string, overrides: Partial<CallParticipant> = {}): CallParticipant => ({
  key: `${identity}/0123456789abcdef`,
  identity,
  s: '0123456789abcdef',
  muted: false,
  camera: false,
  state: 'connected',
  remote: new MediaStream(),
  ...overrides,
});

function call(participants: CallParticipant[], overrides: Partial<Call> = {}): Call {
  return {
    circleKey: 'cc'.repeat(32),
    room: 'check',
    me: ME,
    with: null,
    dial: null,
    connectedAt: null,
    participants,
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

const names = { [ME]: 'Ada Lovelace', [MAYA]: 'Maya Chen', [SAM]: 'Sam' };

describe('CallStage', () => {
  afterEach(cleanup);

  it('renders a tile per person from props, this Mac first', () => {
    render(<CallStage call={call([person(MAYA), person(SAM)])} names={names} />);
    expect(screen.getAllByRole('listitem').map((tile) => tile.getAttribute('aria-label'))).toEqual(['You', 'Maya Chen', 'Sam']);
  });

  it('shows initials when the camera is off and video when it is on', () => {
    const { container } = render(<CallStage call={call([person(MAYA), person(SAM, { camera: true })])} names={names} />);
    const maya = screen.getByRole('listitem', { name: 'Maya Chen' });
    expect(maya.textContent).toContain('MC');
    expect(maya.querySelector('video')).toBeNull();
    expect(screen.getByRole('listitem', { name: 'Sam' }).querySelector('video')).not.toBeNull();
    // Everyone's audio plays, camera or not.
    expect(container.querySelectorAll('audio')).toHaveLength(2);
  });

  it('marks muted people', () => {
    render(<CallStage call={call([person(MAYA, { muted: true }), person(SAM)])} names={names} />);
    expect(screen.getByRole('listitem', { name: 'Maya Chen' }).textContent).toContain('Muted');
    expect(screen.getByRole('listitem', { name: 'Sam' }).textContent).not.toContain('Muted');
  });

  it("shows who can't be reached and retries", () => {
    const retry = vi.fn();
    const maya = person(MAYA, { state: 'unreachable', remote: null });
    render(<CallStage call={call([maya], { retry })} names={names} />);
    expect(screen.getByText("Can't reach Maya Chen from here")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledWith(maya.key);
  });

  it('says someone is still connecting', () => {
    render(<CallStage call={call([person(MAYA, { state: 'connecting', remote: null })])} names={names} />);
    expect(screen.getByRole('listitem', { name: 'Maya Chen' }).textContent).toContain('Connecting…');
  });

  it('shows a waiting tile', () => {
    render(<CallStage call={call([])} names={names} waiting={{ identity: SAM, name: 'Sam' }} />);
    const tile = screen.getByRole('listitem', { name: 'Sam' });
    expect(tile.textContent).toContain('Calling Sam…');
  });

  it('rings a speaking tile', () => {
    const maya = person(MAYA);
    const levels = new Map<MediaStream, (level: number) => void>();
    vi.mocked(watchLevel).mockImplementation((stream, onLevel) => {
      levels.set(stream, onLevel);
      return () => undefined;
    });
    render(<CallStage call={call([maya])} names={names} />);
    const tile = screen.getByRole('listitem', { name: 'Maya Chen' });
    expect(tile.className).not.toContain('is-speaking');
    act(() => levels.get(maya.remote as MediaStream)?.(0.2));
    expect(tile.className).toContain('is-speaking');
    act(() => levels.get(maya.remote as MediaStream)?.(0.01));
    expect(tile.className).not.toContain('is-speaking');
  });
});
