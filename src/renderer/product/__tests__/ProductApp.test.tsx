import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot, seedServiceProgress } from '../../../shared/assistantStackLifecycle';

const useSetup = vi.fn();
const useAssistantStackLifecycle = vi.fn();

vi.mock('../../setup/SetupContext', () => ({
  useSetup: () => useSetup(),
}));

vi.mock('../useAssistantStackLifecycle', () => ({
  useAssistantStackLifecycle: () => useAssistantStackLifecycle(),
}));

vi.mock('../../setup/SetupFlowShell', () => ({
  SetupFlowShell: () => <div>setup-flow</div>,
}));

vi.mock('../ProductReadyShell', () => ({
  ProductReadyShell: () => <div>chat-workbench</div>,
}));

vi.mock('../AssistantStackStartingScreen', () => ({
  AssistantStackStartingScreen: () => <div>starting-screen</div>,
}));

vi.mock('../AssistantStackQuitOverlay', async () => {
  const ReactActual = await import('react');
  return {
    AssistantStackQuitOverlay: ({
      lifecycle,
    }: {
      lifecycle: { phase: string };
    }) =>
      lifecycle.phase === 'stopping' || lifecycle.phase === 'stopped'
        ? ReactActual.createElement('div', null, 'quit-overlay')
        : null,
  };
});

describe('ProductApp gating', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows setup flow when setup is incomplete', async () => {
    useSetup.mockReturnValue({
      allComplete: false,
      assistantStackStatus: null,
    });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('idle'));

    const { ProductApp } = await import('../ProductApp');
    render(<ProductApp />);
    expect(screen.getByText('setup-flow')).toBeTruthy();
  });

  it('shows starting screen when lifecycle is starting', async () => {
    useSetup.mockReturnValue({
      allComplete: true,
      assistantStackStatus: {
        setupComplete: true,
        ready: false,
      },
    });
    useAssistantStackLifecycle.mockReturnValue(
      createLifecycleSnapshot('starting', {
        services: seedServiceProgress('working', 'Starting…', 0.5),
      })
    );

    const { ProductApp } = await import('../ProductApp');
    render(<ProductApp />);
    expect(screen.getByText('starting-screen')).toBeTruthy();
    expect(screen.queryByText('chat-workbench')).toBeNull();
  });

  it('shows chat workbench when ready', async () => {
    useSetup.mockReturnValue({
      allComplete: true,
      assistantStackStatus: {
        setupComplete: true,
        ready: true,
      },
    });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('ready'));

    const { ProductApp } = await import('../ProductApp');
    render(<ProductApp />);
    expect(screen.getByText('chat-workbench')).toBeTruthy();
  });

  it('holds the start-up screen briefly once the stack is ready', async () => {
    vi.useFakeTimers();
    useSetup.mockReturnValue({
      allComplete: true,
      assistantStackStatus: { setupComplete: true, ready: false },
    });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('starting'));

    const { ProductApp, READY_HOLD_MS } = await import('../ProductApp');
    const { rerender } = render(<ProductApp />);
    expect(screen.getByText('starting-screen')).toBeTruthy();

    useSetup.mockReturnValue({
      allComplete: true,
      assistantStackStatus: { setupComplete: true, ready: true },
    });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('ready'));
    rerender(<ProductApp />);
    expect(screen.getByText('starting-screen')).toBeTruthy();
    expect(screen.queryByText('chat-workbench')).toBeNull();

    act(() => vi.advanceTimersByTime(READY_HOLD_MS));
    expect(screen.getByText('chat-workbench')).toBeTruthy();
    vi.useRealTimers();
  });

  it('shows quit overlay while stopping', async () => {
    useSetup.mockReturnValue({
      allComplete: true,
      assistantStackStatus: {
        setupComplete: true,
        ready: true,
      },
    });
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('stopping'));

    const { ProductApp } = await import('../ProductApp');
    render(<ProductApp />);
    expect(screen.getByText('quit-overlay')).toBeTruthy();
    expect(screen.getByText('chat-workbench')).toBeTruthy();
  });
});
