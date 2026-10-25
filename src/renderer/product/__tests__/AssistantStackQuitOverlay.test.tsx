import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createLifecycleSnapshot, seedServiceProgress } from '../../../shared/assistantStackLifecycle';
import { AssistantStackQuitOverlay } from '../AssistantStackQuitOverlay';

describe('AssistantStackQuitOverlay', () => {
  afterEach(cleanup);

  it('renders nothing outside a stop', () => {
    const { container } = render(<AssistantStackQuitOverlay lifecycle={createLifecycleSnapshot('ready')} />);
    expect(container.textContent).toBe('');
  });

  it('empties the ring as tools stop', () => {
    const services = seedServiceProgress('working', 'Stopping…', 0.3).map((s) =>
      s.containerName === 'boundary-searxng' ? { ...s, state: 'done' as const, progress: 1 } : s
    );
    render(<AssistantStackQuitOverlay lifecycle={createLifecycleSnapshot('stopping', { services })} />);
    expect(screen.getByRole('dialog', { name: 'Shutting down your assistant' })).toBeTruthy();
    expect(screen.getByLabelText('Search: stopped')).toBeTruthy();
    expect(screen.getByLabelText('Memory: stopping')).toBeTruthy();
  });

  it('fills the bar once everything has stopped', () => {
    render(<AssistantStackQuitOverlay lifecycle={createLifecycleSnapshot('stopped')} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});
