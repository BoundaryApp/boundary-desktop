import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../shared/types/circles';
import { stubElectronAPI } from '../../__tests__/electronApiFake';
import { SharedModelSetupView } from '../../onboarding/SharedModelSetupView';
import { resetIpcStoresForTests } from '../../lib/ipcStore';
import { InferenceScreen } from '../inference/InferenceScreen';

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
          writable: true,
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

function stub(state: CirclesState, status: object = nothingConnected, stack: object = { entries: [], noPrivate: true }) {
  const setAppSharedModel = vi.fn().mockResolvedValue({ success: true, status: usingShared });
  stubElectronAPI({
    onboarding: {
      getStatus: vi.fn().mockResolvedValue(status),
      describeAppStack: vi.fn().mockResolvedValue(stack),
      setAppFallbacks: vi.fn().mockResolvedValue({ success: true, status: usingShared }),
      setAppSharedModel,
      listConfiguredEndpointModels: vi.fn().mockResolvedValue({ success: true, models: [] }),
    },
    circles: { getState: vi.fn().mockResolvedValue(state) },
  });
  return { setAppSharedModel };
}

afterEach(() => cleanup());

const leftCircle = {
  entries: [{ entry, key: `peer:${CIRCLE}:${BO}:qwen3-8b`, stale: 'left-circle', private: false, privateCut: true }],
  noPrivate: true,
};

describe('choosing a shared model in Inference (ADR 0036)', () => {
  beforeEach(() => resetIpcStoresForTests());

  it('lets a member with no provider make it the first model', async () => {
    const { setAppSharedModel } = stub(circles());
    render(<InferenceScreen />);
    expect(await screen.findByText('Add your first model')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Add to stack' }));
    await waitFor(() => expect(setAppSharedModel).toHaveBeenCalledWith({ entry }));
    await waitFor(() => expect(screen.queryByText('Add your first model')).toBeNull());
  });

  it('won’t add an untrusted provider’s model, and keeps their Trusted switch beside it', async () => {
    const { setAppSharedModel } = stub(circles({ providers: {} }));
    render(<InferenceScreen />);
    const person = await screen.findByRole('region', { name: 'Bo' });
    expect(within(person).getByRole('button', { name: 'Add to stack' })).toHaveProperty('disabled', true);
    expect(within(person).getByRole('switch', { name: 'Trusted' })).toBeTruthy();
    expect(setAppSharedModel).not.toHaveBeenCalled();
  });

  it('says on the entry when its Circle was left, with no fix to offer', async () => {
    stub(circles({ snapshot: { identity: 'a'.repeat(64), circles: [] } }), usingShared, leftCircle);
    render(<InferenceScreen />);
    expect(await screen.findByText('You left that Circle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Trust / })).toBeNull();
  });

  it('offers a first model after a wipe clears the only one', async () => {
    stub(circles({ snapshot: { identity: 'a'.repeat(64), circles: [] } }), { ...nothingConnected, appFallbacks: [] });
    render(<InferenceScreen />);
    expect(await screen.findByText('Add your first model')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Model stack, first to last' })).toBeNull();
  });

  it('shows the error main gives when the model stopped being available', async () => {
    const { setAppSharedModel } = stub(circles());
    setAppSharedModel.mockResolvedValue({ success: false, error: 'Bo isn’t sharing it.', status: nothingConnected });
    render(<InferenceScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to stack' }));
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
