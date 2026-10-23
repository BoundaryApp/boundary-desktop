import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HermesChatCredentialRequestEvent } from '../../../../shared/types/hermesChat';
import { CredentialInterrupt } from '../CredentialInterrupt';

function event(
  overrides: Partial<HermesChatCredentialRequestEvent> = {}
): HermesChatCredentialRequestEvent {
  return {
    rpcRequestId: 'rpc-1',
    sessionId: 'sess-1',
    kind: 'secret',
    envVar: 'GITHUB_TOKEN',
    prompt: 'Needed to open pull requests',
    ...overrides,
  };
}

describe('CredentialInterrupt', () => {
  afterEach(() => cleanup());

  it('asks for a secret with a masked input and sends it on Save', () => {
    const onRespond = vi.fn();
    render(<CredentialInterrupt request={event()} queueSize={1} onRespond={onRespond} />);

    expect(screen.getByText('Secret needed · GITHUB_TOKEN')).toBeTruthy();
    expect(screen.getByText('Needed to open pull requests')).toBeTruthy();
    const input = screen.getByLabelText('GITHUB_TOKEN') as HTMLInputElement;
    expect(input.type).toBe('password');

    const save = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'ghp_123' } });
    fireEvent.click(save);
    expect(onRespond).toHaveBeenCalledWith({ value: 'ghp_123' });
    expect(input.value).toBe('');
  });

  it('skips on Skip and on Escape', () => {
    const onRespond = vi.fn();
    render(<CredentialInterrupt request={event()} queueSize={1} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    fireEvent.keyDown(screen.getByLabelText('GITHUB_TOKEN'), { key: 'Escape' });
    expect(onRespond).toHaveBeenCalledTimes(2);
    expect(onRespond).toHaveBeenNthCalledWith(1, {});
  });

  it('collects a username and password for a site login', () => {
    const onRespond = vi.fn();
    render(
      <CredentialInterrupt
        request={event({
          kind: 'vault.save_login',
          envVar: undefined,
          origin: 'https://github.com',
          site: 'github.com',
        })}
        queueSize={1}
        onRespond={onRespond}
      />
    );
    expect(screen.getByText('Save login · github.com')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'me' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onRespond).toHaveBeenCalledWith({ login: { identifier: 'me', password: 'pw' } });
  });

  it('says where the value goes', () => {
    render(
      <CredentialInterrupt
        request={event({ kind: 'vault.unlock_prompt', displayName: '1Password' })}
        queueSize={1}
        onRespond={() => undefined}
      />
    );
    expect(screen.getByText(/goes to 1Password to unlock it for this chat/)).toBeTruthy();
  });
});
