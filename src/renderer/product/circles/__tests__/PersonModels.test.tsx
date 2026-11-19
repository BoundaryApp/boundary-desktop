import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CirclesState } from '../../../../shared/types/circles';
import type { InferenceChainEntry } from '../../../../shared/types/inferenceChain';
import type { AppSwitchEvent, InferenceSlotId } from '../../../../shared/types/onboarding';
import { BO as bo, CIRCLE_KEY as KEY, ME, circleMember, circleOffer, circleSnapshot, runningCircles } from '../../../__tests__/circleFixtures';
import { stubElectronAPI } from '../../../__tests__/electronApiFake';
import { PersonModels, ProviderClaims } from '../PersonPanel';
import { useCirclesState } from '../useCircles';

const getState = vi.fn();
const setProviderSettings = vi.fn();
const getStatus = vi.fn();
const setAppSharedModel = vi.fn();
const setAppFallbacks = vi.fn();

stubElectronAPI({
  circles: {
    getState: (...args: unknown[]) => getState(...args),
    setProviderSettings: (...args: unknown[]) => setProviderSettings(...args),
    onState: () => (): void => undefined,
  },
  onboarding: {
    getStatus: (...args: unknown[]) => getStatus(...args),
    setAppSharedModel: (...args: unknown[]) => setAppSharedModel(...args),
    setAppFallbacks: (...args: unknown[]) => setAppFallbacks(...args),
    getAppSwitch: async (): Promise<AppSwitchEvent> => ({ appSwitch: null }),
    onAppSwitch: () => (): void => undefined,
  },
});

const SECOND = 'd'.repeat(64);
const offer = circleOffer({ models: [{ id: 'qwen3-8b', contextLength: 32768, tools: true }] });
const entry = { slot: 'peer', modelId: 'qwen3-8b', peer: { circleId: KEY, providerId: bo } };
const localConnected = {
  configured: true,
  slots: { local: { configured: true, endpointUrl: 'http://127.0.0.1:11434/v1', modelId: 'qwen3-8b', health: 'reachable' } },
};

function offering(overrides: Partial<CirclesState> = {}): CirclesState {
  const members = [circleMember({ identity: ME, name: 'Ada', isMe: true }), circleMember({ identity: bo, name: 'Bo' })];
  return runningCircles({ circles: [circleSnapshot({ members, offers: [offer] })], ...overrides });
}

/** Bo's trust and models, as Inference and setup mount them. */
function Person() {
  const circles = useCirclesState();
  if (circles.status !== 'running') return null;
  return (
    <section aria-label="Bo">
      <ProviderClaims identity={bo} name="Bo" circles={circles} />
      <PersonModels identity={bo} name="Bo" circles={circles} />
    </section>
  );
}

async function openBo(state: CirclesState) {
  getState.mockResolvedValue(state);
  render(<Person />);
  return screen.findByRole('region', { name: 'Bo' });
}

beforeEach(() => {
  vi.clearAllMocks();
  getStatus.mockResolvedValue(localConnected);
});

describe('A person’s models', () => {
  it('saves what the user accepts from a provider', async () => {
    const state = offering({ providers: { [bo]: { private: false, trusted: true } } });
    setProviderSettings.mockResolvedValue({ success: true, state });
    const panel = await openBo(state);
    expect(within(panel).getByRole('switch', { name: 'Trusted' }).getAttribute('aria-checked')).toBe('true');
    expect(within(panel).getByText(/sees every prompt it serves/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('switch', { name: 'Allow in private projects' }));
    expect(setProviderSettings).toHaveBeenCalledWith({ identity: bo, private: true, trusted: true });
  });

  it('holds a model back until its provider is trusted', async () => {
    const panel = await openBo(offering());
    expect((await within(panel).findByRole<HTMLButtonElement>('button', { name: 'Use as default' })).disabled).toBe(true);
    expect(within(panel).getByText('Trust Bo to use this model.')).toBeTruthy();
  });

  it('makes a trusted provider’s model the default', async () => {
    const usingBo = { ...localConnected, appDefault: null as InferenceSlotId | null, appSharedModel: entry, appFallbacks: [] as InferenceChainEntry[] };
    setAppSharedModel.mockResolvedValue({ success: true, status: usingBo });
    const panel = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
    await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Use as default' })));
    expect(setAppSharedModel).toHaveBeenCalledWith({ entry });
    expect(await within(panel).findByText('Your default model')).toBeTruthy();
  });

  it('shows main’s refusal', async () => {
    setAppSharedModel.mockResolvedValue({ success: false, error: 'Bo isn’t sharing it.', status: localConnected });
    const panel = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
    await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Use as default' })));
    expect(await within(panel).findByText('Bo isn’t sharing it.')).toBeTruthy();
  });

  it('adds the model to the fallbacks, once', async () => {
    const connected = { ...localConnected, appDefault: 'local', appFallbacks: [] as InferenceChainEntry[] };
    getStatus.mockResolvedValue(connected);
    setAppFallbacks.mockResolvedValue({ success: true, status: { ...connected, appFallbacks: [entry] } });
    const panel = await openBo(offering({ providers: { [bo]: { private: false, trusted: true } } }));
    fireEvent.click(await within(panel).findByRole('button', { name: 'Add as fallback' }));
    await act(async () => undefined);
    expect(setAppFallbacks).toHaveBeenCalledWith({ fallbacks: [entry] });
    expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'In your fallbacks' }).disabled).toBe(true);
  });

  it('says a default provider who lost trust leaves chats waiting', async () => {
    getStatus.mockResolvedValue({ ...localConnected, appDefault: null, appSharedModel: entry, appFallbacks: [] });
    const panel = await openBo(offering());
    expect(await within(panel).findByText(/Still your default, but chats can't use it until you trust Bo/)).toBeTruthy();
  });

  it('shows a person in two Circles once, using a Circle where the model answers', async () => {
    const base = offering({ providers: { [bo]: { private: false, trusted: true } } });
    const [first] = base.snapshot.circles;
    const state: CirclesState = {
      ...base,
      snapshot: {
        ...base.snapshot,
        circles: [
          { ...first, offers: [{ ...offer, available: false }] },
          { ...first, key: SECOND, name: 'Book group', offers: [offer] },
        ],
      },
    };
    setAppSharedModel.mockResolvedValue({ success: true, status: localConnected });
    const panel = await openBo(state);
    expect(within(panel).getAllByRole('switch')).toHaveLength(2);
    expect(within(panel).getAllByText('qwen3-8b')).toHaveLength(1);
    await act(async () => fireEvent.click(await within(panel).findByRole('button', { name: 'Use as default' })));
    expect(setAppSharedModel).toHaveBeenCalledWith({ entry: { ...entry, peer: { circleId: SECOND, providerId: bo } } });
  });
});
