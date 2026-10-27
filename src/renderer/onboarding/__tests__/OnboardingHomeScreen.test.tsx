import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnboardingHomeScreen } from '../OnboardingHomeScreen';

const openRouter = {
  id: 'openrouter' as const,
  displayName: 'OpenRouter',
  description: 'Sign in with OpenRouter',
};

function renderHome(props: { oauthConnecting: boolean; onCancelSignIn?: () => void }) {
  render(
    <OnboardingHomeScreen
      oauthProvider={openRouter}
      oauthLoading={false}
      oauthConnecting={props.oauthConnecting}
      oauthError={null}
      onSignIn={vi.fn()}
      onCancelSignIn={props.onCancelSignIn}
      localEndpoints={[]}
      onUseLocalEndpoint={vi.fn()}
      onUseExisting={vi.fn()}
      onConnectLocalManual={vi.fn()}
    />
  );
}

describe('OnboardingHomeScreen', () => {
  afterEach(() => {
    cleanup();
  });

  it('offers Cancel while waiting for the browser sign-in', () => {
    const onCancelSignIn = vi.fn();
    renderHome({ oauthConnecting: true, onCancelSignIn });

    expect(screen.getByRole('button', { name: 'Waiting for authorization…' })).toHaveProperty(
      'disabled',
      true
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelSignIn).toHaveBeenCalledTimes(1);
  });

  it('hides Cancel when no sign-in is in progress', () => {
    renderHome({ oauthConnecting: false, onCancelSignIn: vi.fn() });

    expect(screen.getByRole('button', { name: 'Sign in with OpenRouter' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
