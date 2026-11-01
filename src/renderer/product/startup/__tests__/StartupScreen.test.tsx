// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedServiceProgress } from '../../../../shared/assistantStackLifecycle';
import { expectedOffsets, type StartTiming } from '../../../../shared/startupTiming';
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
    // The footer is complete from the start, so the story arriving doesn't move it.
    expect(screen.getByRole('button', { name: 'Why does this take a while?' })).toBeTruthy();
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

  const startTiming = (overrides: Partial<StartTiming> = {}): StartTiming => ({
    startedAt: Date.now(),
    kind: 'relaunch',
    expected: expectedOffsets('relaunch', []),
    expectedServices: {},
    reached: {},
    fromHistory: true,
    ...overrides,
  });

  const outline = (container: HTMLElement, label: string) =>
    container
      .querySelector(`[aria-label^="${label}:"] .su-tile-fill path`)
      ?.getAttribute('style');

  it('fills each tile outline toward when that tool is expected up', () => {
    const timing = startTiming({
      startedAt: Date.now() - 50_000,
      expectedServices: { 'boundary-n8n': 100_000, 'boundary-searxng': 200_000 },
    });
    const { container } = render(
      <StartupScreen variant="launch" stage="compose" services={services} startTiming={timing} />
    );
    expect(outline(container, 'Automations')).toContain('stroke-dasharray: 50 100');
    expect(outline(container, 'Search')).toContain('stroke-dasharray: 25 100');
  });

  it('never moves a tile outline backwards', () => {
    const timing = startTiming({ startedAt: Date.now() - 50_000 });
    const props = { variant: 'launch', stage: 'compose', services } as const;
    const { container, rerender } = render(
      <StartupScreen
        {...props}
        startTiming={{ ...timing, expectedServices: { 'boundary-n8n': 100_000 } }}
      />
    );
    rerender(
      <StartupScreen
        {...props}
        startTiming={{ ...timing, expectedServices: { 'boundary-n8n': 900_000 } }}
      />
    );
    expect(outline(container, 'Automations')).toContain('stroke-dasharray: 50 100');
  });

  it('keeps the travelling arc when there is no start timing', () => {
    const { container } = render(
      <StartupScreen variant="launch" stage="compose" services={services} />
    );
    expect(container.querySelector('.su-tile-fill')).toBeNull();
    expect(container.querySelector('[data-filled]')).toBeNull();
  });

  it('never moves the bar backwards', () => {
    const ahead = startTiming({ reached: { apiBootstrapDone: 1_000 } });
    const { rerender } = render(
      <StartupScreen variant="launch" stage="compose" services={services} startTiming={ahead} />
    );
    const bar = screen.getByRole('progressbar');
    const before = Number(bar.getAttribute('aria-valuenow'));
    rerender(
      <StartupScreen variant="launch" stage="compose" services={services} startTiming={startTiming()} />
    );
    expect(Number(bar.getAttribute('aria-valuenow'))).toBe(before);
  });

  it('starts the bar again after Try again', () => {
    const ahead = startTiming({ reached: { apiBootstrapDone: 1_000 } });
    const { rerender } = render(
      <StartupScreen variant="launch" stage="compose" services={services} startTiming={ahead} />
    );
    const peak = Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'));
    rerender(<StartupScreen variant="launch" stage="error" services={services} error="compose failed" onRetry={() => undefined} />);
    rerender(
      <StartupScreen variant="launch" stage="provision" services={services} startTiming={startTiming()} />
    );
    expect(Number(screen.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeLessThan(peak);
  });

  it('moves the bar with time while the containers report nothing new', () => {
    const running = startTiming({ reached: { prepared: 0, toolsStarting: 0 } });
    render(<StartupScreen variant="launch" stage="compose" services={services} startTiming={running} />);
    const bar = screen.getByRole('progressbar');
    const before = Number(bar.getAttribute('aria-valuenow'));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeGreaterThan(before + 10);
  });

  it('gives a loose estimate from earlier starts, and only steps it down', () => {
    const { rerender } = render(
      <StartupScreen variant="launch" stage="compose" services={services} startTiming={startTiming()} />
    );
    expect(screen.getByText('About 4 minutes left')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText('A couple of minutes left')).toBeTruthy();
    // A later milestone that puts the run behind doesn't raise the figure.
    const started = Date.now() - 60_000;
    rerender(
      <StartupScreen
        variant="launch"
        stage="compose"
        services={services}
        startTiming={startTiming({ startedAt: started, reached: { prepared: 30_000 } })}
      />
    );
    expect(screen.getByText('A couple of minutes left')).toBeTruthy();
  });

  it('says it is unsure on a kind of start this Mac has not finished', () => {
    render(
      <StartupScreen
        variant="launch"
        stage="compose"
        services={services}
        startTiming={startTiming({ fromHistory: false })}
      />
    );
    expect(screen.getByText('This usually takes a few minutes')).toBeTruthy();
  });

  it('shows each service card at the progress main reports for this start', () => {
    const { rerender } = render(
      <StartupScreen variant="launch" stage="error" services={seedServiceProgress('working', 'Pulling', 0.8)} error="compose failed" />
    );
    expect(screen.getAllByRole('status', { name: /80%/ }).length).toBeGreaterThan(0);
    rerender(
      <StartupScreen variant="launch" stage="error" services={seedServiceProgress('working', 'Pulling', 0.1)} error="compose failed" />
    );
    expect(screen.queryAllByRole('status', { name: /80%/ })).toHaveLength(0);
    expect(screen.getAllByRole('status', { name: /10%/ }).length).toBeGreaterThan(0);
  });

  it('shows bytes downloaded and speed while a pull is running', () => {
    const MiB = 1024 * 1024;
    const at = (receivedBytes: number) => ({ receivedBytes, seenBytes: receivedBytes * 2 });
    const { rerender } = render(
      <StartupScreen variant="first-run" stage="compose" services={services} download={at(100 * MiB)} />
    );
    expect(screen.getByText('100 MB downloaded')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2_000));
    rerender(<StartupScreen variant="first-run" stage="compose" services={services} download={at(120 * MiB)} />);
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

  it('explains the wait in a popover that Escape closes', () => {
    render(<StartupScreen variant="first-run" stage="provision" services={services} />);
    const why = screen.getByRole('button', { name: 'Why does this take a while?' });
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(why);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('note').textContent).toMatch(/Later launches skip the download/);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('opens details in a side panel and closes it', () => {
    render(
      <StartupScreen variant="launch" stage="compose" message="compose up" services={services} />
    );
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText('compose up')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show details' }));
  });

  it('opens details on error and lets the user close them', () => {
    render(<StartupScreen variant="launch" stage="error" services={services} error="Something odd" />);
    expect(screen.getByRole('complementary', { name: 'Details' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
  });

  it('says ready when the stack is up', () => {
    render(<StartupScreen variant="first-run" stage="ready" services={services} />);
    expect(screen.getByRole('heading', { name: 'Your assistant is ready' })).toBeTruthy();
    expect(screen.queryByText('Show details')).toBeNull();
  });
});
