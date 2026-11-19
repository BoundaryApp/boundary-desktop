import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HermesChatCredentialRequestEvent } from '../../../../shared/types/hermesChat';
import { CaptureSecretInterrupt } from '../CaptureSecretInterrupt';

function event(overrides: Partial<HermesChatCredentialRequestEvent> = {}): HermesChatCredentialRequestEvent {
  return {
    rpcRequestId: 'rpc-1',
    sessionId: 'sess-1',
    kind: 'vault.capture_secret',
    origin: 'https://dash.example.com',
    site: 'dash.example.com',
    name: 'EXAMPLE_API_KEY',
    destination: 'env',
    last4: 'a1b2',
    replaces: false,
    ...overrides,
  };
}

describe('CaptureSecretInterrupt', () => {
  afterEach(() => cleanup());

  it('names the variable, site and last four, and approves an env capture', () => {
    const onRespond = vi.fn();
    render(<CaptureSecretInterrupt request={event()} queueSize={1} onRespond={onRespond} />);

    expect(screen.getByText('Save key · EXAMPLE_API_KEY')).toBeTruthy();
    expect(screen.getByText(/a key ending in a1b2 on dash\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/Saved to this agent's settings as EXAMPLE_API_KEY/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save key/ }));
    expect(onRespond).toHaveBeenCalledWith({ approve: true });
  });

  it('says when the key replaces one the agent has', () => {
    render(<CaptureSecretInterrupt request={event({ replaces: true })} queueSize={1} onRespond={vi.fn()} />);
    expect(screen.getByText(/Replaces the EXAMPLE_API_KEY this agent already has/)).toBeTruthy();
  });

  it('declines with no answer, from the button and from Escape', () => {
    const onRespond = vi.fn();
    render(<CaptureSecretInterrupt request={event()} queueSize={1} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onRespond).toHaveBeenLastCalledWith({});

    fireEvent.keyDown(screen.getByRole('button', { name: 'Decline' }), { key: 'Escape' });
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenLastCalledWith({});
  });

  it('offers only Decline for a key meant for this app, and Enter does nothing', () => {
    const onRespond = vi.fn();
    render(
      <CaptureSecretInterrupt request={event({ destination: 'viewer' })} queueSize={1} onRespond={onRespond} />
    );
    expect(screen.getByText(/which can't take keys yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Save key/ })).toBeNull();
    fireEvent.submit(screen.getByRole('button', { name: 'Decline' }).closest('form')!);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('disables every action while an answer is in flight', () => {
    render(<CaptureSecretInterrupt request={event()} queueSize={1} busy onRespond={vi.fn()} />);
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
