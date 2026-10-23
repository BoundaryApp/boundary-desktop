import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridgeApprovalEvent } from '../../../../shared/types/hostBridge';
import { HostBridgeApproval } from '../HostBridgeApproval';

function event(overrides: Partial<HostBridgeApprovalEvent> = {}): HostBridgeApprovalEvent {
  return {
    id: 'apr-1',
    capability: 'notify',
    title: 'Show a notification',
    detail: 'Build finished\nAll tests passed',
    alwaysDescription: 'Hermes can show notifications without asking.',
    choices: ['allow', 'always', 'deny'],
    expiresAt: Date.now() + 120_000,
    ...overrides,
  };
}

describe('HostBridgeApproval', () => {
  afterEach(() => cleanup());

  it("shows Boundary's reading of the call and allows it", () => {
    const onRespond = vi.fn();
    render(<HostBridgeApproval approval={event()} queueSize={1} onRespond={onRespond} />);
    expect(screen.getByText('On this computer · Show a notification')).toBeTruthy();
    expect(screen.getByText(/Build finished/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onRespond).toHaveBeenCalledWith('allow');
  });

  it('denies on Escape and allows on Enter', () => {
    const onRespond = vi.fn();
    render(<HostBridgeApproval approval={event()} queueSize={1} onRespond={onRespond} />);
    const card = screen.getByRole('alertdialog');
    fireEvent.keyDown(card, { key: 'Escape' });
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onRespond.mock.calls).toEqual([['deny'], ['allow']]);
  });

  it('asks for confirmation before "always"', () => {
    const onRespond = vi.fn();
    render(<HostBridgeApproval approval={event()} queueSize={2} onRespond={onRespond} />);
    expect(screen.getByText('1 / 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow…' }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByText('Hermes can show notifications without asking.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Always allow' }));
    expect(onRespond).toHaveBeenCalledWith('always');
  });

  it('offers no "Always allow" for calls that ask every time', () => {
    const onRespond = vi.fn();
    render(
      <HostBridgeApproval
        approval={event({ capability: 'clipboard_read', title: 'Read your clipboard', alwaysDescription: undefined, choices: ['allow', 'deny'] })}
        queueSize={1}
        onRespond={onRespond}
      />
    );
    expect(screen.queryByRole('button', { name: 'Always allow…' })).toBeNull();
  });

  it('ignores clicks while busy', () => {
    const onRespond = vi.fn();
    render(<HostBridgeApproval approval={event()} queueSize={1} busy onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    expect(onRespond).not.toHaveBeenCalled();
  });
});
