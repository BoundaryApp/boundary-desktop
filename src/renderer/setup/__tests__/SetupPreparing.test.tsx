import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeProvisionSnapshot } from '../../../shared/types/capability';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { SetupProvider } from '../SetupContext';
import { SetupFlowShell } from '../SetupFlowShell';
import { preparingRows } from '../preparingSteps';

const T0 = new Date('2026-11-18T12:00:00Z').getTime();

function snapshot(
  stage: RuntimeProvisionSnapshot['stage'],
  reached: RuntimeProvisionSnapshot['reached'],
  stageStartedAt = T0
): RuntimeProvisionSnapshot {
  return { stage, reached, stageStartedAt };
}

describe('preparingRows', () => {
  it('shows Docker and the checks while Docker is being looked for', () => {
    const rows = preparingRows(snapshot('docker', ['docker']));
    expect(rows.map((r) => [r.id, r.look])).toEqual([
      ['docker', 'run'],
      ['checks', 'pending'],
    ]);
  });

  it('adds the engine rows once the resolve falls back, and Create only when the machine is made', () => {
    const starting = preparingRows(snapshot('start', ['docker', 'configure', 'start']));
    expect(starting.map((r) => [r.id, r.look])).toEqual([
      ['docker', 'done'],
      ['configure', 'done'],
      ['start', 'run'],
      ['connect', 'pending'],
      ['checks', 'pending'],
    ]);
    const creating = preparingRows(snapshot('create', ['docker', 'configure', 'create']));
    expect(creating.map((r) => r.id)).toEqual(['docker', 'configure', 'create', 'start', 'connect', 'checks']);
  });

  it('marks a skipped Start done when the machine was already running', () => {
    const rows = preparingRows(snapshot('connect', ['docker', 'configure', 'connect']));
    expect(rows.find((r) => r.id === 'start')?.look).toBe('done');
  });

  it('runs the checks row once a runtime is ready', () => {
    const rows = preparingRows(snapshot('ready', ['docker', 'ready']));
    expect(rows.map((r) => [r.id, r.look])).toEqual([
      ['docker', 'done'],
      ['checks', 'run'],
    ]);
  });
});

describe('Preparing screen in setup', () => {
  let sendStage: (snapshot: RuntimeProvisionSnapshot) => void = () => undefined;
  let sendProgress: (message: string) => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stubElectronAPI({
      capability: {
        getStatus: vi.fn().mockResolvedValue({ acknowledged: false, lastAssessment: null }),
        // The Machine check stays running for the whole test.
        assess: vi.fn(() => new Promise(() => undefined)),
        onProvisionStage: vi.fn((listener: (s: RuntimeProvisionSnapshot) => void): (() => void) => {
          sendStage = listener;
          return () => undefined;
        }),
        onProgress: vi.fn((listener: (m: string) => void): (() => void) => {
          sendProgress = listener;
          return () => undefined;
        }),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function renderSetup() {
    render(
      <SetupProvider>
        <SetupFlowShell />
      </SetupProvider>
    );
    // Let getStatus answer and the assessment start.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('keeps the spinner until the runtime resolve reports a stage', async () => {
    await renderSetup();
    expect(screen.getByText('Loading setup…')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Preparing steps' })).toBeNull();
  });

  it('shows the engine’s steps, its latest line and time on the running step', async () => {
    await renderSetup();
    act(() => {
      sendStage(snapshot('create', ['docker', 'configure', 'create']));
      sendProgress('Using bundled machine image…');
    });

    const list = screen.getByRole('list', { name: 'Preparing steps' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-look'))).toEqual([
      'done',
      'done',
      'run',
      'pending',
      'pending',
      'pending',
    ]);
    expect(within(rows[2]).getByText('Create the engine')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Using bundled machine image…');
    expect(within(rows[2]).getByText('0s')).toBeTruthy();

    act(() => vi.advanceTimersByTime(95_000));
    expect(within(rows[2]).getByText('1m')).toBeTruthy();
    // Creating gets five minutes before the screen calls it slow.
    expect(screen.queryByText(/Still going/)).toBeNull();

    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(screen.getByText(/Still going/)).toBeTruthy();
    expect(screen.getByText('Troubleshooting')).toBeTruthy();
  });

  it('moves on as stages arrive and says slow after a minute on a short step', async () => {
    await renderSetup();
    act(() => sendStage(snapshot('docker', ['docker'])));
    expect(screen.getByRole('status').textContent).toBe('Look for Docker…');

    act(() => vi.advanceTimersByTime(2_000));
    act(() => sendStage(snapshot('start', ['docker', 'configure', 'start'], Date.now())));
    act(() => sendProgress('Starting Boundary container engine…'));
    const rows = within(screen.getByRole('list', { name: 'Preparing steps' })).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-look'))).toEqual(['done', 'done', 'run', 'pending', 'pending']);
    expect(within(rows[0]).getByText('Done')).toBeTruthy();
    expect(screen.queryByText(/Still going/)).toBeNull();

    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByText(/Still going/)).toBeTruthy();
  });
});
