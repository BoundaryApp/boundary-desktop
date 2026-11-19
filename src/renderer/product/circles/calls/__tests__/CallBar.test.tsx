import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Missed } from '../callService';
import { CallBar } from '../CallBar';
import { closeCallView, useCallViewOpen } from '../callViewState';
import { CIRCLE, personCall, SAM } from './callBarFakes';

const hook = vi.hoisted(() => ({
  state: { call: null, rings: [], missed: null, service: { call: vi.fn(async () => undefined), clearMissed: vi.fn() } } as {
    call: unknown;
    rings: unknown[];
    missed: Missed | null;
    service: { call: ReturnType<typeof vi.fn>; clearMissed: ReturnType<typeof vi.fn> };
  },
}));
vi.mock('../useCallService', () => ({ useCallService: () => hook.state }));
vi.mock('../../../useAppShortcuts', () => ({ dispatchAppCommand: vi.fn() }));

const names = (_circle: string, _identity: string) => 'Sam';

function ViewFlag() {
  return <span data-testid="view">{useCallViewOpen() ? 'open' : 'closed'}</span>;
}

describe('CallBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    hook.state.call = null;
    hook.state.missed = null;
    hook.state.service.call.mockClear();
    hook.state.service.clearMissed.mockClear();
    closeCallView();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders nothing without a call or a missed call', () => {
    const { container } = render(<CallBar names={names} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows Calling Sam… while ringing and the duration once connected', () => {
    hook.state.call = personCall({ dial: 'calling', connectedAt: null });
    const { rerender } = render(<CallBar names={names} />);
    expect(screen.getByText('Calling Sam…')).toBeTruthy();
    hook.state.call = personCall({ connectedAt: Date.now() });
    rerender(<CallBar names={names} />);
    expect(screen.getByText('0:00')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(72_000));
    expect(screen.getByText('1:12')).toBeTruthy();
  });

  it('shows No answer, busy and declined with Try again and Close', () => {
    const cases: Array<[Missed['reason'], string]> = [
      ['no-answer', 'No answer'],
      ['busy', 'Sam is in another call'],
      ['declined', 'Sam declined'],
    ];
    for (const [reason, text] of cases) {
      hook.state.missed = { circleKey: CIRCLE, with: SAM, reason };
      const { unmount } = render(<CallBar names={names} />);
      expect(screen.getByText(text)).toBeTruthy();
      unmount();
    }
    render(<CallBar names={names} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(hook.state.service.call).toHaveBeenCalledWith(CIRCLE, SAM, { audio: true, video: false });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(hook.state.service.clearMissed).toHaveBeenCalled();
  });

  it('Try again leaves a join that fails to the service, which records it', async () => {
    hook.state.missed = { circleKey: CIRCLE, with: SAM, reason: 'no-answer' };
    const failed = Promise.reject(new Error('The join was cancelled.'));
    const handled = vi.spyOn(failed, 'then');
    hook.state.service.call.mockReturnValueOnce(failed);
    render(<CallBar names={names} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handled).toHaveBeenCalled();
    await act(async () => {
      await failed.catch((): undefined => undefined);
    });
  });

  it('mutes, turns the camera on and leaves', () => {
    const call = personCall();
    hook.state.call = call;
    render(<CallBar names={names} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(call.mute).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Camera on' }));
    expect(call.setCamera).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(call.leave).toHaveBeenCalled();
  });

  it('offers Unmute and Camera off when they are on', () => {
    hook.state.call = personCall({ muted: true, camera: true });
    render(<CallBar names={names} />);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Camera off' })).toBeTruthy();
  });

  it('floats when asked', () => {
    hook.state.call = personCall();
    const { container, rerender } = render(<CallBar names={names} />);
    expect(container.querySelector('.is-floating')).toBeNull();
    rerender(<CallBar floating names={names} />);
    expect(container.querySelector('.is-floating')).not.toBeNull();
  });

  it('the name opens the call view', () => {
    hook.state.call = personCall();
    render(
      <>
        <CallBar names={names} />
        <ViewFlag />
      </>,
    );
    expect(screen.getByTestId('view').textContent).toBe('closed');
    fireEvent.click(screen.getByRole('button', { name: /Sam/ }));
    expect(screen.getByTestId('view').textContent).toBe('open');
  });
});
