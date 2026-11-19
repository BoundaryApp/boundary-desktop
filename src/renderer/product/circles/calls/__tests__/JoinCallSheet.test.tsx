import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../../__tests__/electronApiFake';
import type { MediaAccessStatus } from '../../../../../shared/types/media';
import { JoinCallSheet } from '../JoinCallSheet';

vi.mock('../audioLevel', () => ({ watchLevel: vi.fn(() => vi.fn()) }));

type Track = { kind: string; stop: ReturnType<typeof vi.fn> };
const streamOf = (kind: string) => {
  const track: Track = { kind, stop: vi.fn() };
  // happy-dom's video element only takes a real MediaStream, which keeps no tracks it didn't make.
  const stream = Object.assign(new MediaStream(), {
    getTracks: () => [track],
    getAudioTracks: () => (kind === 'audio' ? [track] : []),
  }) as unknown as MediaStream;
  return { track, stream };
};

let asked: string[];
let requested: string[];
let made: Track[];
let opened: string[];
let status: Record<'camera' | 'microphone', MediaAccessStatus>;
let devices: Array<Partial<MediaDeviceInfo>>;

beforeEach(() => {
  asked = [];
  requested = [];
  made = [];
  opened = [];
  status = { camera: 'granted', microphone: 'granted' };
  devices = [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Desk mic' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Desk camera' },
  ];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => devices,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        const kind = constraints.audio ? 'audio' : 'video';
        asked.push(kind);
        const made1 = streamOf(kind);
        made.push(made1.track);
        return made1.stream;
      },
    },
  });
  stubElectronAPI({
    media: {
      getAccess: async () => status,
      requestAccess: async (device: 'camera' | 'microphone') => {
        requested.push(device);
        return status[device];
      },
      openPrivacySettings: async (device: string) => {
        opened.push(device);
      },
    },
  });
});

afterEach(() => cleanup());

const renderSheet = () => {
  const onJoin = vi.fn();
  render(<JoinCallSheet title="Call Maya" onJoin={onJoin} onCancel={vi.fn()} />);
  return onJoin;
};
const settled = () => act(async () => undefined);
const DENIED = (device: string) => `Boundary can't use the ${device}. Turn it on in System Settings › Privacy & Security.`;

describe('JoinCallSheet', () => {
  it('asks for the microphone on open and not the camera', async () => {
    renderSheet();
    await settled();
    expect(requested).toEqual(['microphone']);
    expect(asked).toEqual(['audio']);
    expect(screen.getByRole('meter', { name: 'Microphone level' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Camera' }).getAttribute('aria-checked')).toBe('false');
  });

  it('turning the camera on asks for it and shows a preview', async () => {
    renderSheet();
    await settled();
    fireEvent.click(screen.getByRole('switch', { name: 'Camera' }));
    await settled();
    expect(requested).toEqual(['microphone', 'camera']);
    expect(document.querySelector('video')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Camera' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a denied microphone shows the line, opens System Settings and joins without it', async () => {
    status.microphone = 'denied';
    const onJoin = renderSheet();
    await settled();
    expect(screen.getByText(DENIED('microphone'))).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(opened).toEqual(['microphone']);
    fireEvent.click(screen.getByRole('button', { name: 'Join without microphone' }));
    expect(onJoin).toHaveBeenCalledWith({ audio: false, video: false });
  });

  it('a denied camera turns the switch back off', async () => {
    status.camera = 'denied';
    renderSheet();
    await settled();
    fireEvent.click(screen.getByRole('switch', { name: 'Camera' }));
    await settled();
    expect(screen.getByRole('switch', { name: 'Camera' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(DENIED('camera'))).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open System Settings' }));
    expect(opened).toEqual(['camera']);
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy();
  });

  it('stops the preview before joining', async () => {
    const onJoin = renderSheet();
    await settled();
    fireEvent.click(screen.getByRole('switch', { name: 'Camera' }));
    await settled();
    expect(made.map((track) => track.kind)).toEqual(['audio', 'video']);
    onJoin.mockImplementation(() => expect(made.every((track) => track.stop.mock.calls.length > 0)).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith({ audio: true, video: true });
  });

  it('Join passes the picked devices', async () => {
    const onJoin = renderSheet();
    await settled();
    fireEvent.click(screen.getByRole('switch', { name: 'Camera' }));
    await settled();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Desk mic' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic-1' } });
    fireEvent.change(screen.getByLabelText('Camera', { selector: 'select' }), { target: { value: 'cam-1' } });
    await settled();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith({ audio: true, video: true, microphone: 'mic-1', camera: 'cam-1' });
  });
});
