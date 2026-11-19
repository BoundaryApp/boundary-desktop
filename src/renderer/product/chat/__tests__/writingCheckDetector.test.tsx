import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import type { DetectorCheckResult, DetectorStatus } from '../../../../shared/types/writingCheck';
import { WritingCheckPane, type WritingCheckRequest } from '../WritingCheckPane';

const detectorStatus = vi.fn<() => Promise<DetectorStatus>>();
const checkWithDetector = vi.fn<(p: { text: string }) => Promise<DetectorCheckResult>>();
const agreeToDetector = vi.fn(async () => ({ success: true }));

stubElectronAPI({ writingCheck: { detectorStatus, checkWithDetector, agreeToDetector } });

const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
const DATA_LEAVES = 'The text you check is sent to the detector you chose, Pangram or GPTZero, under your account with them.';

const check = (markdown = LONG): WritingCheckRequest => ({ seq: 1, messageId: 'm1', markdown, source: 'Reply' });

async function renderPane(markdown?: string) {
  render(<WritingCheckPane check={check(markdown)} onClose={vi.fn()} onShowReply={vi.fn()} onRecheckFile={vi.fn()} />);
  await act(async () => undefined);
}

const available = (consented: boolean): DetectorStatus => ({
  available: true,
  provider: 'pangram',
  dataLeaves: DATA_LEAVES,
  consented,
});

const scored: DetectorCheckResult = {
  ok: true,
  score: {
    provider: 'pangram',
    score: 0.82,
    label: 'AI',
    model: 'v3',
    segments: [
      { start: 0, end: 12, score: 0.9 },
      { start: 13, end: 25, score: 0.2 },
    ],
    checkedAt: '2026-11-12T10:00:00Z',
  },
};

describe('Detector score in the Check pane', () => {
  beforeEach(() => {
    detectorStatus.mockReset();
    checkWithDetector.mockReset();
    agreeToDetector.mockClear();
  });
  afterEach(cleanup);

  it('shows nothing about detectors without the add-on', async () => {
    detectorStatus.mockResolvedValue({ available: false });
    await renderPane();
    expect(screen.queryByRole('button', { name: 'Get detector score' })).toBeNull();
    expect(screen.queryByText(/Pangram|GPTZero/)).toBeNull();
  });

  it('says what leaves the Mac and asks before the first send to a provider', async () => {
    detectorStatus.mockResolvedValue(available(false));
    checkWithDetector.mockResolvedValue(scored);
    await renderPane();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get detector score' })));
    expect(checkWithDetector).not.toHaveBeenCalled();
    expect(screen.getByText(DATA_LEAVES)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send to Pangram' })));
    expect(agreeToDetector).toHaveBeenCalledWith({ provider: 'pangram' });
    expect(checkWithDetector).toHaveBeenCalledWith({ text: LONG });
  });

  it('cancels without sending', async () => {
    detectorStatus.mockResolvedValue(available(false));
    await renderPane();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get detector score' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(checkWithDetector).not.toHaveBeenCalled();
    expect(agreeToDetector).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Get detector score' })).toBeTruthy();
  });

  it('sends at once once agreed, and shows the provider’s score, label and high passages', async () => {
    detectorStatus.mockResolvedValue(available(true));
    checkWithDetector.mockResolvedValue(scored);
    await renderPane();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get detector score' })));
    expect(agreeToDetector).not.toHaveBeenCalled();

    const result = screen.getByTestId('detector-result');
    expect(result.textContent).toContain('Pangram');
    expect(result.textContent).toContain('AI');
    expect(result.textContent).toContain('0.82');
    expect(result.textContent).toContain('not comparable');
    const detected = [...document.querySelectorAll('.wb-check-prose .is-detected')].map((el) => el.textContent);
    expect(detected).toEqual(['word0 word1 ']);
  });

  it('holds the button under 50 words, as the add-on would refuse', async () => {
    detectorStatus.mockResolvedValue(available(true));
    await renderPane('Too short to score.');
    expect((screen.getByRole('button', { name: 'Get detector score' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Pangram needs 50 words or more.')).toBeTruthy();
  });

  it('shows the add-on’s error, with when to try again', async () => {
    detectorStatus.mockResolvedValue(available(true));
    checkWithDetector.mockResolvedValue({
      ok: false,
      error: { code: 'quota', message: 'Pangram is out of credits.', retryAfter: 30 },
    });
    await renderPane();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get detector score' })));
    expect(screen.getByRole('alert').textContent).toBe('Pangram is out of credits. Try again in 30 s.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
