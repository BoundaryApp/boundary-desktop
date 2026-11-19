import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HermesChatCredentialRequestEvent } from '../../../../shared/types/hermesChat';
import { CreateLoginInterrupt } from '../CreateLoginInterrupt';

function event(overrides: Partial<HermesChatCredentialRequestEvent> = {}): HermesChatCredentialRequestEvent {
  return {
    rpcRequestId: 'rpc-1',
    sessionId: 'sess-1',
    kind: 'vault.create_login',
    origin: 'https://app.example.com',
    site: 'app.example.com',
    identifier: 'me@example.com',
    regenerate: false,
    ...overrides,
  };
}

describe('CreateLoginInterrupt', () => {
  afterEach(() => cleanup());

  it('names the site and identifier, and approves a generated password', () => {
    const onRespond = vi.fn();
    render(<CreateLoginInterrupt request={event()} queueSize={1} onRespond={onRespond} />);

    expect(screen.getByText('New login · app.example.com')).toBeTruthy();
    expect(screen.getByText(/signing up at https:\/\/app\.example\.com as me@example\.com/)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Generate password/ }));
    expect(onRespond).toHaveBeenCalledWith({ createLogin: { generate: true } });
  });

  it('declines with no answer, from the button and from Escape', () => {
    const onRespond = vi.fn();
    render(<CreateLoginInterrupt request={event()} queueSize={1} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(onRespond).toHaveBeenLastCalledWith({});

    fireEvent.keyDown(screen.getByRole('button', { name: 'Decline' }), { key: 'Escape' });
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenLastCalledWith({});
  });

  it('sends a typed password and clears it', () => {
    const onRespond = vi.fn();
    render(<CreateLoginInterrupt request={event()} queueSize={1} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my own' }));

    const input = screen.getByLabelText('Password') as HTMLInputElement;
    expect(input.type).toBe('password');
    const submit = screen.getByRole('button', { name: /Use this password/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'my-own-pw' } });
    fireEvent.click(submit);
    expect(onRespond).toHaveBeenCalledWith({ createLogin: { password: 'my-own-pw' } });
    expect(input.value).toBe('');
  });

  it('goes back to a generated password and forgets the typed one', () => {
    const onRespond = vi.fn();
    render(<CreateLoginInterrupt request={event()} queueSize={1} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use my own' }));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate one instead' }));
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Generate password/ }));
    expect(onRespond).toHaveBeenCalledWith({ createLogin: { generate: true } });
  });

  it('says when it replaces a password the site refused', () => {
    render(<CreateLoginInterrupt request={event({ regenerate: true })} queueSize={1} onRespond={vi.fn()} />);
    expect(screen.getByText('New password · app.example.com')).toBeTruthy();
    expect(screen.getByText(/didn't accept the password/)).toBeTruthy();
    expect(screen.getByText(/Replaces the password saved for this login/)).toBeTruthy();
  });

  it('disables every action while an answer is in flight', () => {
    render(<CreateLoginInterrupt request={event()} queueSize={1} busy onRespond={vi.fn()} />);
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
