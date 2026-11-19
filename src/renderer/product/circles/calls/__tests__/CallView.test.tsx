import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallView } from '../CallView';
import { ME, personCall, SAM } from './callBarFakes';

vi.mock('../audioLevel', () => ({ watchLevel: vi.fn((): (() => void) => () => undefined) }));

const names = { [ME]: 'Ada', [SAM]: 'Sam' };

describe('CallView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-2', label: 'USB mic' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'Desk camera' },
        ],
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the people count and that nothing is kept', () => {
    render(<CallView call={personCall({ connectedAt: Date.now() - 252_000 })} names={names} onBack={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Sam' })).toBeTruthy();
    expect(screen.getByText('Call · 2 people · 4:12 · nothing is recorded or kept')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText('Call · 2 people · 4:13 · nothing is recorded or kept')).toBeTruthy();
  });

  it('counts one person as a person, while ringing', () => {
    render(<CallView call={personCall({ dial: 'calling', connectedAt: null, participants: [] })} names={names} onBack={() => undefined} />);
    expect(screen.getByText('Call · 1 person · 0:00 · nothing is recorded or kept')).toBeTruthy();
  });

  it('is a labelled section, not a second main, inside the screen it sits in', () => {
    render(
      <main>
        <CallView call={personCall()} names={names} onBack={() => undefined} />
      </main>,
    );
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Sam' })).toBeTruthy();
  });

  it('Back to chat closes the view', () => {
    const onBack = vi.fn();
    render(<CallView call={personCall()} names={names} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('Devices switches the microphone', async () => {
    vi.useRealTimers();
    const call = personCall();
    render(<CallView call={call} names={names} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }));
    const select = (await screen.findByLabelText('Microphone')) as HTMLSelectElement;
    await screen.findByRole('option', { name: 'USB mic' });
    fireEvent.change(select, { target: { value: 'mic-2' } });
    expect(call.setDevice).toHaveBeenCalledWith('audio', 'mic-2');
  });

  it('has Mute, Camera on and Leave under the tiles', () => {
    const call = personCall();
    render(<CallView call={call} names={names} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(call.mute).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Camera on' }));
    expect(call.setCamera).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(call.leave).toHaveBeenCalled();
  });
});
