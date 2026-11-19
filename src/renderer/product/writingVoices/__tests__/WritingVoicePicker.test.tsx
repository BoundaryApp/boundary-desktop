import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';

const openSettings = vi.hoisted(() => vi.fn());
vi.mock('../../settingsNavigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../settingsNavigation')>()),
  openSettings,
}));

import { WritingVoicePicker } from '../WritingVoicePicker';

const view = (id: string, over: Partial<WritingVoiceView> = {}): WritingVoiceView => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  status: 'ready',
  pieces: 1,
  words: 1,
  createdAt: '',
  calibratedAt: null,
  sampleHash: '',
  style: null,
  samplesChanged: false,
  step: null,
  ...over,
});

const voices = [view('plain'), view('news', { status: 'calibrating' }), view('blog', { status: 'not-calibrated' })];

beforeEach(() => openSettings.mockReset());

describe('WritingVoicePicker', () => {
  it('lists No voice, ready voices, and not-ready ones disabled', () => {
    render(<WritingVoicePicker label="Chat replies" value={null} voices={voices} onChange={vi.fn()} />);
    const select = screen.getByLabelText('Chat replies') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => [o.text, o.disabled]);
    expect(options).toEqual([
      ['No voice', false],
      ['Plain', false],
      ['News · Calibrating', true],
      ['Blog · Not calibrated', true],
      ['New voice…', false],
      ['Manage voices…', false],
    ]);
    expect(screen.getByText('How it talks to you here')).toBeTruthy();
  });

  it('reports a pick and No voice as null', () => {
    const onChange = vi.fn();
    render(<WritingVoicePicker label="Drafts" value="plain" voices={voices} onChange={onChange} />);
    expect(screen.getByText('Posts, emails and documents it writes for you')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Drafts'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('opens Settings for New voice… and Manage voices… and keeps the value', () => {
    const onChange = vi.fn();
    render(<WritingVoicePicker label="Drafts" value="plain" voices={voices} onChange={onChange} />);
    const select = screen.getByLabelText('Drafts') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '__new' } });
    expect(openSettings).toHaveBeenLastCalledWith({ tab: 'writing-voices', newWritingVoice: true });
    fireEvent.change(select, { target: { value: '__manage' } });
    expect(openSettings).toHaveBeenLastCalledWith({ tab: 'writing-voices' });
    expect(onChange).not.toHaveBeenCalled();
    expect(select.value).toBe('plain');
  });
});
