import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../shared/types/circles';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { SharedModelSetupView } from '../../onboarding/SharedModelSetupView';
import { ProductSettingsScreen } from '../ProductSettingsScreen';

const CIRCLE = 'c'.repeat(64);
const BO = 'b'.repeat(64);
const entry = { slot: 'peer' as const, modelId: 'qwen3-8b', peer: { circleId: CIRCLE, providerId: BO } };

function circles(overrides: Partial<CirclesState> = {}): CirclesState {
  return {
    status: 'running',
    displayName: 'Ada',
    providers: { [BO]: { private: false, trusted: true } },
    sharing: { models: [], circles: [], paused: false, away: false },
    snapshot: {
      identity: 'a'.repeat(64),
      circles: [
        {
          key: CIRCLE,
          name: 'Workshop',
          myRole: 'member',
          members: [],
          invites: [],
          offers: [
            {
              identity: BO,
              name: 'Bo',
              isMine: false,
              models: [{ id: 'qwen3-8b', tools: true, contextLength: 16_384 }],
              available: true,
              away: false,
              online: true,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const nothingConnected = { configured: false, encryptionAvailable: true, appDefault: null, slots: {} };
const usingShared = { ...nothingConnected, configured: true, appSharedModel: entry, appFallbacks: [] };

function stub(state: CirclesState, status: object = nothingConnected) {
  const setAppSharedModel = vi.fn().mockResolvedValue({ success: true, status: usingShared });
  stubElectronAPI({
    onboarding: {
      getStatus: vi.fn().mockResolvedValue(status),
      setAppSharedModel,
      listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    },
    circles: { getState: vi.fn().mockResolvedValue(state) },
  });
  return { setAppSharedModel };
}

afterEach(() => cleanup());

describe('choosing a shared model in Settings (ADR 0036)', () => {
  it('lets a member with no provider make it the app default, and the warning goes', async () => {
    const { setAppSharedModel } = stub(circles());
    render(<ProductSettingsScreen onBack={() => undefined} />);
    expect(await screen.findByText(/No model provider is connected/)).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /Bo's qwen3-8b/ }));

    await waitFor(() => expect(setAppSharedModel).toHaveBeenCalledWith({ entry }));
    await waitFor(() => expect(screen.queryByText(/No model provider is connected/)).toBeNull());
    expect(await screen.findByText(/App default updated/)).toBeTruthy();
    // Fallbacks can follow it, like any app default.
    expect(screen.getByRole('heading', { name: /Fallbacks/ })).toBeTruthy();
  });

  it('holds back a model until its provider is trusted, and says where to do that', async () => {
    stub(circles({ providers: {} }));
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const choice = (await screen.findByRole('button', { name: /Bo's qwen3-8b/ })) as HTMLButtonElement;
    expect(choice.disabled).toBe(true);
    expect(choice.textContent).toMatch(/Trust Bo in Circles to use it/);
  });

  it('keeps showing a chosen model that stopped being shared, with what that means', async () => {
    stub(circles({ snapshot: { identity: 'a'.repeat(64), circles: [] } }), usingShared);
    render(<ProductSettingsScreen onBack={() => undefined} />);
    const choice = await screen.findByRole('button', { name: /qwen3-8b/ });
    expect(choice.className).toContain('is-on');
    expect(choice.textContent).toMatch(/Chats can’t send until that changes/);
  });

  it('shows the error main gives when the model stopped being available', async () => {
    const { setAppSharedModel } = stub(circles());
    setAppSharedModel.mockResolvedValue({ success: false, error: 'Bo isn’t sharing it.', status: nothingConnected });
    render(<ProductSettingsScreen onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /Bo's qwen3-8b/ }));
    expect(await screen.findByText('Bo isn’t sharing it.')).toBeTruthy();
  });
});

describe('choosing a shared model in setup (ADR 0036)', () => {
  it('asks for a name, then an invite', async () => {
    stub(circles({ displayName: '', snapshot: { identity: '', circles: [] } }));
    render(<SharedModelSetupView />);
    expect(await screen.findByLabelText('Your name in Circles')).toBeTruthy();
    cleanup();
    stub(circles({ snapshot: { identity: 'a'.repeat(64), circles: [] } }));
    render(<SharedModelSetupView />);
    expect(await screen.findByRole('form', { name: 'Join a Circle' })).toBeTruthy();
  });

  it('waits for a member to share', async () => {
    const state = circles();
    state.snapshot.circles[0].offers = [];
    stub(state);
    render(<SharedModelSetupView />);
    expect(await screen.findByText(/Nobody in your Circle is sharing a model yet/)).toBeTruthy();
  });

  it('asks for trust beside the choice, then picks the model', async () => {
    const { setAppSharedModel } = stub(circles({ providers: {} }));
    render(<SharedModelSetupView />);
    expect(await screen.findByRole('switch', { name: 'Trusted' })).toBeTruthy();
    expect(((await screen.findByRole('button', { name: 'Use as default' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add as fallback' })).toBeNull();
    cleanup();
    stub(circles());
    render(<SharedModelSetupView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use as default' }));
    await waitFor(() => expect(window.electronAPI.onboarding.setAppSharedModel).toHaveBeenCalledWith({ entry }));
    expect(setAppSharedModel).not.toHaveBeenCalled();
  });
});
