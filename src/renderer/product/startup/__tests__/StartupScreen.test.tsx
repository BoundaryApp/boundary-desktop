// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedServiceProgress } from '../../../../shared/assistantStackLifecycle';
import { STARTUP_TOOLS } from '../startupModel';
import { STORY_CARD_MS, STORY_DELAY_MS, StartupScreen } from '../StartupScreen';

const services = seedServiceProgress('pending', 'Queued…', 0.05);

describe('StartupScreen', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows the tool story straight away on first run', () => {
    render(<StartupScreen variant="first-run" stage="provision" services={services} />);
    expect(screen.getByRole('heading', { name: 'Setting up your assistant' })).toBeTruthy();
    expect(screen.getByText('Downloading your tools')).toBeTruthy();
    expect(screen.getByRole('heading', { name: STARTUP_TOOLS[0].title })).toBeTruthy();
    expect(screen.getByText('Why does this take a while?')).toBeTruthy();
  });

  it('keeps a quick launch minimal, then adds the story', () => {
    render(<StartupScreen variant="launch" stage="compose" services={services} />);
    expect(screen.getByRole('heading', { name: 'Starting your assistant' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: STARTUP_TOOLS[0].title })).toBeNull();
    act(() => vi.advanceTimersByTime(STORY_DELAY_MS + 1_000));
    expect(screen.getByRole('heading', { name: STARTUP_TOOLS[0].title })).toBeTruthy();
  });

  it('rotates story cards and lets the user pick one', () => {
    render(<StartupScreen variant="first-run" stage="compose" services={services} />);
    act(() => vi.advanceTimersByTime(STORY_CARD_MS));
    expect(screen.getByRole('heading', { name: STARTUP_TOOLS[1].title })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Show ${STARTUP_TOOLS[4].title}` }));
    expect(screen.getByRole('heading', { name: STARTUP_TOOLS[4].title })).toBeTruthy();
  });

  it('never moves the bar backwards', () => {
    const { rerender } = render(
      <StartupScreen variant="launch" stage="compose" services={seedServiceProgress('working', '', 0.8)} />
    );
    const bar = screen.getByRole('progressbar');
    const before = Number(bar.getAttribute('aria-valuenow'));
    rerender(<StartupScreen variant="launch" stage="compose" services={services} />);
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(before);
  });

  it('shows bytes downloaded and speed while a pull is running', () => {
    const at = (receivedBytes: number) => ({ receivedBytes, seenBytes: receivedBytes * 2 });
    const { rerender } = render(
      <StartupScreen variant="first-run" stage="compose" services={services} download={at(100_000_000)} />
    );
    expect(screen.getByText('100 MB downloaded')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2_000));
    rerender(<StartupScreen variant="first-run" stage="compose" services={services} download={at(120_000_000)} />);
    expect(screen.getByText('120 MB downloaded · 10 MB/s')).toBeTruthy();
    // A stalled pull drops the line rather than showing a stale speed.
    act(() => vi.advanceTimersByTime(11_000));
    expect(screen.queryByText(/downloaded/)).toBeNull();
  });

  it('labels each tool with its state', () => {
    const one = services.map((s) =>
      s.containerName === 'boundary-searxng' ? { ...s, state: 'done' as const, progress: 1 } : s
    );
    render(<StartupScreen variant="launch" stage="compose" services={one} />);
    expect(screen.getByLabelText('Search: ready')).toBeTruthy();
    expect(screen.getByLabelText('Memory: waiting')).toBeTruthy();
  });

  it('shows the error with details and a retry', () => {
    const onRetry = vi.fn();
    render(
      <StartupScreen
        variant="launch"
        stage="error"
        message="compose up exited 1"
        services={services}
        error="Hermes API did not become healthy"
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole('heading', { name: 'Your assistant didn’t respond in time' })).toBeTruthy();
    // The raw error replaces the progress message under details.
    expect(screen.getByText('Hermes API did not become healthy')).toBeTruthy();
    expect(screen.queryByText('compose up exited 1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('falls back to a general message for an unrecognised error', () => {
    render(<StartupScreen variant="launch" stage="error" services={services} error="Something odd" />);
    expect(screen.getByRole('heading', { name: 'Your assistant didn’t start' })).toBeTruthy();
    expect(screen.getByText('Something odd')).toBeTruthy();
  });

  it('says ready when the stack is up', () => {
    render(<StartupScreen variant="first-run" stage="ready" services={services} />);
    expect(screen.getByRole('heading', { name: 'Your assistant is ready' })).toBeTruthy();
    expect(screen.queryByText('Show details')).toBeNull();
  });
});
