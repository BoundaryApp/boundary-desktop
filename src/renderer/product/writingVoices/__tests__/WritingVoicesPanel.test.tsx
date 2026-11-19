import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type {
  WritingVoiceCheckSummary,
  WritingVoiceRecord,
  WritingVoiceSource,
} from '../../../../shared/types/writingVoices';
import { WritingVoicesPanel } from '../WritingVoicesPanel';

const list = vi.fn();
const check = vi.fn();
const pick = vi.fn();
const create = vi.fn();
const pathForFile = vi.fn();
const calibrate = vi.fn();
let progress: ((p: unknown) => void) | null = null;

const record = (over: Partial<WritingVoiceRecord> = {}): WritingVoiceRecord => ({
  id: 'field-notes',
  name: 'Field notes',
  status: 'not-calibrated',
  pieces: 3,
  words: 6880,
  createdAt: '2026-11-11T12:00:00.000Z',
  calibratedAt: null,
  sampleHash: 'h',
  ...over,
});

/** A summary that echoes the sources: PDFs refused, "list" in a name marks it list-heavy. */
function summarize(sources: WritingVoiceSource[]): WritingVoiceCheckSummary {
  const files = sources.map((source, i) => {
    const label = source.kind === 'file' ? source.path.split('/').pop()! : `Pasted text ${i + 1}`;
    const pdf = label.endsWith('.pdf');
    return {
      label,
      source,
      words: pdf ? 0 : 200,
      listHeavy: label.includes('list'),
      refused: pdf ? ('type' as const) : null,
      ...(pdf ? { extension: 'PDF' } : {}),
    };
  });
  const used = files.filter((f) => f.refused === null);
  return {
    files,
    pieces: used.length,
    words: used.length * 200,
    longPieces: 1,
    listHeavy: used.filter((f) => f.listHeavy).length,
    enough: false,
  };
}

beforeEach(() => {
  for (const fn of [list, check, pick, create, pathForFile]) fn.mockReset();
  list.mockResolvedValue({ success: true, voices: [] });
  check.mockImplementation(async (sources: WritingVoiceSource[]) => summarize(sources));
  stubElectronAPI({
    writingVoices: {
      list: (...a: unknown[]) => list(...a),
      check: (...a: unknown[]) => check(...a),
      pick: (...a: unknown[]) => pick(...a),
      create: (...a: unknown[]) => create(...a),
      pathForFile: (f: File) => pathForFile(f),
      calibrate: (...a: unknown[]) => calibrate(...a),
      onProgress: (cb: (p: unknown) => void) => {
        progress = cb;
        return () => {
          progress = null;
        };
      },
    },
    onboarding: {
      getStatus: vi.fn().mockResolvedValue({
        configured: true,
        encryptionAvailable: true,
        appDefault: 'local',
        slots: { local: { configured: true, modelId: 'qwen3-32b' } },
      }),
      onStatus: () => (): void => undefined,
    },
  });
});

async function openSheetWithTwoFiles() {
  pick.mockResolvedValue({ canceled: false, paths: ['/w/scan.pdf', '/w/winter-list.md'] });
  render(<WritingVoicesPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'New voice…' }));
  const sheet = await screen.findByRole('dialog');
  fireEvent.click(within(sheet).getByRole('button', { name: 'Choose files…' }));
  await within(sheet).findByText('winter-list.md');
  return sheet;
}

describe('WritingVoicesPanel', () => {
  it('says when there are no voices', async () => {
    render(<WritingVoicesPanel />);
    expect(await screen.findByText('No writing voices yet.')).toBeTruthy();
  });

  it('lists a voice with its counts and status', async () => {
    list.mockResolvedValue({ success: true, voices: [record()] });
    render(<WritingVoicesPanel />);
    expect(await screen.findByText('Field notes')).toBeTruthy();
    expect(screen.getByText('3 pieces, 6,880 words')).toBeTruthy();
    expect(screen.getByText('Not calibrated')).toBeTruthy();
  });

  it('shows why a file is not used, list-heavy files, and how many more pieces to add', async () => {
    const sheet = await openSheetWithTwoFiles();
    expect(within(sheet).getByText('Not added: PDF')).toBeTruthy();
    expect(within(sheet).getByText('Mostly headers and lists')).toBeTruthy();
    expect(
      within(sheet).getByText(
        'Calibration works best from five or more pieces of 500 words or more. Add 4 more for a steadier voice.',
        { exact: false }
      )
    ).toBeTruthy();
    expect(within(sheet).getByText(/1 file is mostly headers and lists/)).toBeTruthy();
    expect(within(sheet).getByText('1 of 1 over 500 words')).toBeTruthy();
  });

  it('checks again without a file that was removed', async () => {
    const sheet = await openSheetWithTwoFiles();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Remove scan.pdf' }));
    await waitFor(() =>
      expect(check).toHaveBeenLastCalledWith([{ kind: 'file', path: '/w/winter-list.md' }])
    );
    expect(within(sheet).queryByText('scan.pdf')).toBeNull();
  });

  it('creates the voice with the trimmed name and shows it', async () => {
    const sheet = await openSheetWithTwoFiles();
    const confirm = within(sheet).getByRole('button', { name: 'Create voice' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: '  Field notes ' } });
    expect(confirm.disabled).toBe(false);
    create.mockResolvedValue({ success: true, voice: record() });
    list.mockResolvedValue({ success: true, voices: [{ ...record(), style: null, samplesChanged: false, step: null }] });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(create).toHaveBeenCalledWith({
      name: 'Field notes',
      sources: [
        { kind: 'file', path: '/w/scan.pdf' },
        { kind: 'file', path: '/w/winter-list.md' },
      ],
    });
    expect(await screen.findByText('Field notes')).toBeTruthy();
  });

  it('says the samples are copying while the create runs', async () => {
    const sheet = await openSheetWithTwoFiles();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'Field notes' } });
    let finish: (value: unknown) => void = () => {};
    create.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create voice' }));
    const copying = (await within(sheet).findByRole('button', { name: 'Copying samples…' })) as HTMLButtonElement;
    expect(copying.disabled).toBe(true);
    expect((within(sheet).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ success: false, error: 'The voice could not be saved. Nothing was kept.' }));
    expect(within(sheet).getByRole('button', { name: 'Create voice' })).toBeTruthy();
  });

  it('keeps the sheet open with the error main gives', async () => {
    const sheet = await openSheetWithTwoFiles();
    fireEvent.change(within(sheet).getByLabelText('Name'), { target: { value: 'newsletter' } });
    create.mockResolvedValue({ success: false, error: 'A voice called Newsletter already exists.' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Create voice' }));
    expect(await within(sheet).findByText('A voice called Newsletter already exists.')).toBeTruthy();
  });

  it('adds pasted text', async () => {
    render(<WritingVoicesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'New voice…' }));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Paste text' }));
    fireEvent.change(within(sheet).getByLabelText('Pasted text'), {
      target: { value: 'Some writing of mine.' },
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(check).toHaveBeenLastCalledWith([{ kind: 'pasted', text: 'Some writing of mine.' }])
    );
    expect(await within(sheet).findByText('Pasted text 1')).toBeTruthy();
  });

  it('adds dropped files by their paths', async () => {
    pathForFile.mockImplementation((f: File) => `/drop/${f.name}`);
    render(<WritingVoicesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'New voice…' }));
    const sheet = await screen.findByRole('dialog');
    const zone = within(sheet).getByText('Drop .md, .txt or .rst files here');
    const files = [new File(['a'], 'a.md'), new File(['b'], 'b.md')];
    fireEvent.drop(zone, { dataTransfer: { files, types: ['Files'] } });
    await waitFor(() =>
      expect(check).toHaveBeenLastCalledWith([
        { kind: 'file', path: '/drop/a.md' },
        { kind: 'file', path: '/drop/b.md' },
      ])
    );
  });

  it('follows calibration progress and reloads when it ends', async () => {
    list.mockResolvedValue({ success: true, voices: [{ ...record({ status: 'calibrating' }), style: null, samplesChanged: false, step: 'starting' }] });
    render(<WritingVoicesPanel />);
    expect(await screen.findByText('Calibrating')).toBeTruthy();
    act(() => progress?.({ id: 'field-notes', status: 'calibrating', step: 'writing', lastError: null }));
    expect(screen.getByText('Writing the style guide').closest('li')?.getAttribute('aria-current')).toBe('step');
    list.mockResolvedValue({ success: true, voices: [{ ...record({ status: 'ready' }), style: null, samplesChanged: false, step: null }] });
    act(() => progress?.({ id: 'field-notes', status: 'ready', step: null, lastError: null }));
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('names the model that will calibrate', async () => {
    render(<WritingVoicesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'New voice…' }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText('Calibrates with Local · qwen3-32b')).toBeTruthy();
  });

  it('opens straight on the create sheet when asked to', async () => {
    render(<WritingVoicesPanel startCreating />);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('New writing voice')).toBeTruthy();
  });
});
