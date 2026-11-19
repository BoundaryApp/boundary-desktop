import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { WritingVoiceView } from '../../../../shared/types/writingVoices';
import { WritingVoiceCard } from '../WritingVoiceCard';

const api = {
  calibrate: vi.fn(),
  setNeverDoes: vi.fn(),
  samples: vi.fn(),
  removeSample: vi.fn(),
  addSamples: vi.fn(),
  pick: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  users: vi.fn(),
  openStyle: vi.fn(),
  reveal: vi.fn(),
};

const view = (over: Partial<WritingVoiceView> = {}): WritingVoiceView => ({
  id: 'ops',
  name: 'Ops',
  status: 'ready',
  pieces: 2,
  words: 6880,
  createdAt: '',
  calibratedAt: '2026-11-11T12:00:00.000Z',
  sampleHash: 'h',
  lastError: null,
  style: {
    description: 'Plain and short.',
    neverDoes: ['Never shouts', 'Never hedges'],
    exemplars: ['samples/a.md'],
    chars: 4210,
    calibrated: '2026-11-11',
  },
  samplesChanged: false,
  step: null,
  ...over,
});

let onChange: ReturnType<typeof vi.fn<(voice: WritingVoiceView) => void>>;
let onDeleted: ReturnType<typeof vi.fn<(id: string) => void>>;

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.calibrate.mockResolvedValue({ success: true });
  stubElectronAPI({
    writingVoices: Object.fromEntries(
      Object.entries(api).map(([k, fn]) => [k, (...a: unknown[]) => fn(...a)])
    ),
  });
  onChange = vi.fn<(voice: WritingVoiceView) => void>();
  onDeleted = vi.fn<(id: string) => void>();
});

const show = (v: WritingVoiceView) =>
  render(<WritingVoiceCard voice={v} onChange={onChange} onDeleted={onDeleted} />);

describe('WritingVoiceCard', () => {
  it('shows a ready voice with its description and Never does', () => {
    show(view());
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('2 pieces, 6,880 words · calibrated 11 Nov · STYLE.md 4,210 characters')).toBeTruthy();
    expect(screen.getByText('Plain and short.')).toBeTruthy();
    expect(screen.getByText('Never shouts')).toBeTruthy();
  });

  it('offers Try again after a failed calibration', () => {
    show(view({ status: 'not-calibrated', style: null, calibratedAt: null, lastError: 'Start the assistant first.' }));
    expect(screen.getByText('Not calibrated')).toBeTruthy();
    expect(screen.getByText('Start the assistant first.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(api.calibrate).toHaveBeenCalledWith('ops');
    expect(screen.queryByRole('button', { name: 'Open STYLE.md' })).toBeNull();
  });

  it('offers Calibrate when it has never run', () => {
    show(view({ status: 'not-calibrated', style: null, calibratedAt: null }));
    expect(screen.getByRole('button', { name: 'Calibrate' })).toBeTruthy();
  });

  it('offers Recalibrate when the samples changed', () => {
    show(view({ samplesChanged: true }));
    expect(screen.getByText('Samples changed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recalibrate' }));
    expect(api.calibrate).toHaveBeenCalledWith('ops');
  });

  it('shows where calibration has got to', () => {
    show(view({ status: 'calibrating', step: 'reading', style: null }));
    expect(screen.getByText('Calibrating')).toBeTruthy();
    expect(screen.getByText('Reading the samples').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText("You can leave this page. The voice can be picked once it's ready.")).toBeTruthy();
  });

  it('saves Never does with trimmed lines', async () => {
    const saved = view({ style: { ...view().style!, neverDoes: ['Never whispers'] } });
    api.setNeverDoes.mockResolvedValue({ success: true, voice: saved });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const inputs = screen.getAllByRole('textbox', { name: 'Never does' });
    fireEvent.change(inputs[0], { target: { value: '  Never whispers ' } });
    fireEvent.change(inputs[1], { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setNeverDoes).toHaveBeenCalledWith('ops', ['Never whispers']));
    expect(onChange).toHaveBeenCalledWith(saved);
  });

  it('keeps an error from saving Never does on screen', async () => {
    api.setNeverDoes.mockResolvedValue({ success: false, error: 'This voice has no style guide yet. Calibrate it first.' });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This voice has no style guide yet. Calibrate it first.')).toBeTruthy();
  });

  it('warns when STYLE.md is too long for chat replies', () => {
    show(view({ style: { ...view().style!, chars: 16_001 } }));
    expect(screen.getByText('Too long for chat replies (over 16,000 characters). Shorten STYLE.md.')).toBeTruthy();
  });

  it('deletes after confirming', async () => {
    api.users.mockResolvedValue({ success: true, agents: [] });
    api.delete.mockResolvedValue({ success: true });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('Delete Ops?')).toBeTruthy();
    expect(within(sheet).getByText("The voice's folder, with its 2 samples and style guide, moves to the Trash.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete voice' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('ops'));
    expect(api.delete).toHaveBeenCalledWith('ops');
  });

  it('lists samples and removes one', async () => {
    api.samples.mockResolvedValue({ success: true, files: [{ name: 'a.md', words: 20 }, { name: 'b.md', words: 30 }] });
    const after = view({ pieces: 1 });
    api.removeSample.mockResolvedValue({ success: true, voice: after });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Samples (2)' }));
    expect(await screen.findByText('a.md')).toBeTruthy();
    expect(screen.getByText('20 words')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.md' }));
    await waitFor(() => expect(api.removeSample).toHaveBeenCalledWith('ops', 'a.md'));
    expect(onChange).toHaveBeenCalledWith(after);
  });

  it('renames', async () => {
    const renamed = view({ name: 'Field notes' });
    api.rename.mockResolvedValue({ success: true, voice: renamed });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Voice name' }), { target: { value: 'Field notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(api.rename).toHaveBeenCalledWith('ops', 'Field notes'));
    expect(onChange).toHaveBeenCalledWith(renamed);
  });

  it('names the agents that use the voice before deleting', async () => {
    api.users.mockResolvedValue({
      success: true,
      agents: [
        { slug: 'juniper', displayName: 'Juniper', uses: ['chat-replies'] },
        { slug: 'assistant', displayName: 'Marlow', uses: ['chat-replies', 'drafts'] },
      ],
    });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(
      await screen.findByText("Juniper's chat replies and Marlow's chat replies and drafts go back to No voice.")
    ).toBeTruthy();
  });

  it('counts the chats that keep the voice before deleting', async () => {
    api.users.mockResolvedValue({ success: true, agents: [], chats: 2 });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText("2 chats that kept this voice go back to their agents' voices.")).toBeTruthy();
  });

  it('says one chat in the singular', async () => {
    api.users.mockResolvedValue({ success: true, agents: [], chats: 1 });
    show(view());
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByText("1 chat that kept this voice goes back to its agent's voice.")).toBeTruthy();
  });
});

