import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleSnapshot } from '../../../shared/assistantStackLifecycle';
import type { AssistantStackLifecycleSnapshot } from '../../../shared/types/assistantStack';

const useAssistantStackLifecycle = vi.fn<() => AssistantStackLifecycleSnapshot>();
vi.mock('../../product/assistantStack', () => ({
  useAssistantStackLifecycle: () => useAssistantStackLifecycle(),
}));

const { SetupBackgroundStatus } = await import('../SetupBackgroundStatus');

describe('SetupBackgroundStatus', () => {
  afterEach(cleanup);

  it('says nothing before the stack starts', () => {
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('idle'));
    const { container } = render(<SetupBackgroundStatus />);
    expect(container.textContent).toBe('');
  });

  it('shows the stage and bytes while the stack starts', () => {
    useAssistantStackLifecycle.mockReturnValue({
      ...createLifecycleSnapshot('starting', { stage: 'compose' }),
      download: { receivedBytes: 1_500_000_000, seenBytes: 2_000_000_000 },
    });
    render(<SetupBackgroundStatus />);
    expect(screen.getByRole('status').textContent).toBe('Starting your tools· 1.4 GB');
  });

  it('points to the last step on error', () => {
    useAssistantStackLifecycle.mockReturnValue(createLifecycleSnapshot('error', { error: 'x' }));
    render(<SetupBackgroundStatus />);
    expect(screen.getByRole('status').textContent).toContain('the last step shows what happened');
  });
});
